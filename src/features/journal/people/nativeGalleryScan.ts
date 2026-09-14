import { Capacitor, registerPlugin } from '@capacitor/core'
import type { StoredPhotoFaceScan } from './types'

export type NativeGalleryScanPhoto = { key: string; nativeId: string; source: string }
export type NativeGalleryScanResult = { key: string; source: string; scan: StoredPhotoFaceScan }
export type NativeGalleryScanState = {
  revision?: string
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error'
  total: number
  completed: number
  failed: number
  results: NativeGalleryScanResult[]
  failedKeys?: string[]
  error?: string
}

export interface BackgroundGalleryScanPlugin {
  getNotificationPermission(): Promise<{ status: 'prompt' | 'granted' | 'denied' }>
  requestNotificationPermission(): Promise<{ status: 'prompt' | 'granted' | 'denied' }>
  start(options: { scope: string; revision: string; photos: NativeGalleryScanPhoto[] }): Promise<NativeGalleryScanState>
  getState(options: { scope: string; limit?: number }): Promise<NativeGalleryScanState>
  ack(options: { scope: string; entries: { key: string; source: string }[] }): Promise<unknown>
  pause(options: { scope: string }): Promise<unknown>
  resume(options: { scope: string }): Promise<unknown>
  retry(options: { scope: string }): Promise<unknown>
  cancel(options: { scope: string }): Promise<unknown>
  retainScope(options: { scope: string }): Promise<unknown>
}

export const BackgroundGalleryScan = registerPlugin<BackgroundGalleryScanPlugin>('BackgroundGalleryScan')

export function isBackgroundGalleryScanSupported() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BackgroundGalleryScan')
    && typeof Capacitor.getPlatform === 'function' && Capacitor.getPlatform() === 'android'
}

/** Also covers cold launches where Journal's JS coordinator never mounted. */
export function cancelNativeGalleryScan(scope: string) {
  if (isBackgroundGalleryScanSupported()) void BackgroundGalleryScan.cancel({ scope }).catch(() => undefined)
}

/** Forget another signed-in member's native job without restarting this one's. */
export function retainNativeGalleryScope(scope: string) {
  if (isBackgroundGalleryScanSupported()) void BackgroundGalleryScan.retainScope({ scope }).catch(() => undefined)
}

/** Reject malformed bridge output before acknowledging its durable native checkpoint. */
export function isNativeFaceScan(value: unknown): value is StoredPhotoFaceScan {
  if (!value || typeof value !== 'object') return false
  const scan = value as StoredPhotoFaceScan
  if (typeof scan.scannedAt !== 'string' || !Number.isFinite(Date.parse(scan.scannedAt))
    || !Array.isArray(scan.faces) || scan.faces.length > 20) return false
  const ids = new Set<string>()
  const unit = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  return scan.faces.every((face) => {
    if (!face || typeof face !== 'object' || typeof face.id !== 'string' || !face.id || ids.has(face.id)) return false
    ids.add(face.id)
    return Array.isArray(face.embedding) && face.embedding.length === 1024
      && face.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
      && face.embedding.some((n) => n !== 0)
      && Array.isArray(face.box) && face.box.length === 4 && face.box.every(unit)
      && face.box[2] > 0 && face.box[3] > 0
      && face.box[0] + face.box[2] <= 1.000001 && face.box[1] + face.box[3] <= 1.000001
      && unit(face.detectorScore) && unit(face.descriptorScore) && unit(face.quality)
      && typeof face.minFacePixels === 'number' && Number.isFinite(face.minFacePixels)
      && face.minFacePixels >= 0 && face.minFacePixels <= 1280
  })
}
