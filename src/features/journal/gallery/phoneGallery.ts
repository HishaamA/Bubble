import { Capacitor, registerPlugin } from '@capacitor/core'
import { cancelNativeGalleryScan } from '../people/nativeGalleryScan'

export type PhoneGalleryPermission = 'prompt' | 'granted' | 'limited' | 'denied' | 'unavailable'

export type NativePhoneGalleryPhoto = {
  id: string
  capturedAt: string
  width: number
  height: number
  filename: string
  modifiedAt?: string
}

export type PhoneGalleryAsset = {
  /** Stable device-library identity, never a cloud Journal upload. */
  id: string
  nativeId: string
  source: string
  capturedAt: string
  width: number
  height: number
  filename: string
  modifiedAt?: string
}

export interface PhoneGalleryPlugin {
  getPermission(): Promise<{ status: PhoneGalleryPermission }>
  requestPermission(): Promise<{ status: PhoneGalleryPermission }>
  getLibraryRevision(): Promise<{ revision: string }>
  listPhotos(options: { offset: number; limit: number }): Promise<{
    photos: NativePhoneGalleryPhoto[]
    hasMore: boolean
  }>
  readPhoto(options: { id: string; maxDimension: number }): Promise<{ dataUrl: string }>
  openSettings(): Promise<{ opened: boolean }>
}

export const PhoneGallery = registerPlugin<PhoneGalleryPlugin>('PhoneGallery')
export const PHONE_GALLERY_CLEARED_EVENT = 'bubble:phone-gallery-cleared'
export type PhoneGalleryClearedDetail = {
  cacheNamespace: string
  reason: 'disconnect' | 'permission' | 'refresh' | 'account'
  allowedPhotoIds?: string[]
}

const PREFIX = 'bubble-gallery:'
const MAX_CACHE_BYTES = 12 * 1024 * 1024
const MAX_CACHE_ENTRIES = 24
const MAX_JPEG_CHARACTERS = 12 * 1024 * 1024
const authorizations = new Map<string, Set<string>>()
const cache = new Map<string, string>()
const pendingReads = new Map<string, Promise<string>>()
let cacheBytes = 0
let cacheGeneration = 0
let runningReads = 0
const waitingReads: (() => void)[] = []

export function isPhoneGallerySupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PhoneGallery')
}

export function isGalleryPhotoSource(value: unknown): value is `bubble-gallery:${string}` {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Synchronous scoped consent guard for jobs retaining metadata across tab changes. */
export function isGalleryPhotoAuthorized(source: unknown): source is string {
  if (typeof source !== 'string') return false
  try {
    const { cacheNamespace } = parseSource(source)
    return authorizations.get(cacheNamespace)?.has(source) === true
  } catch { return false }
}

export function makeGalleryPhotoSource(nativeId: string, cacheNamespace: string, modifiedAt?: string): string {
  const query = new URLSearchParams({ scope: cacheNamespace })
  if (modifiedAt) query.set('v', modifiedAt)
  return `${PREFIX}${encodeURIComponent(nativeId)}?${query}`
}

function parseSource(source: string): { nativeId: string; cacheNamespace: string } {
  if (!isGalleryPhotoSource(source) || source.length > 8192) throw new Error('Invalid phone photo reference.')
  const separator = source.indexOf('?')
  if (separator < PREFIX.length) throw new Error('Invalid phone photo reference.')
  let nativeId: string
  try { nativeId = decodeURIComponent(source.slice(PREFIX.length, separator)) }
  catch { throw new Error('Invalid phone photo reference.') }
  const query = new URLSearchParams(source.slice(separator + 1))
  const cacheNamespace = query.get('scope') ?? ''
  if (!nativeId || nativeId.length > 2048 || [...nativeId].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
    || !cacheNamespace || cacheNamespace.length > 512 || query.getAll('scope').length !== 1
    || [...query.keys()].some((key) => key !== 'scope' && key !== 'v')) {
    throw new Error('Invalid phone photo reference.')
  }
  return { nativeId, cacheNamespace }
}

/** Pass only currently consented references into the device's background queue. */
export function authorizedGalleryNativeId(source: unknown, namespace: string): string | null {
  if (typeof source !== 'string' || !isGalleryPhotoAuthorized(source)) return null
  try {
    const parsed = parseSource(source)
    return parsed.cacheNamespace === namespace ? parsed.nativeId : null
  } catch { return null }
}

export function setGalleryAuthorization(cacheNamespace: string, photos: readonly PhoneGalleryAsset[]): void {
  authorizations.set(cacheNamespace, new Set(photos.map((photo) => photo.source)))
  // A successfully refreshed selection may have lost previously granted assets.
  for (const [key, dataUrl] of cache) {
    const source = key.slice(0, key.lastIndexOf('\u0000'))
    try {
      const parsed = parseSource(source)
      if (parsed.cacheNamespace === cacheNamespace && !authorizations.get(cacheNamespace)?.has(source)) {
        cache.delete(key)
        cacheBytes -= dataUrl.length * 2
      }
    } catch {
      cache.delete(key)
      cacheBytes -= dataUrl.length * 2
    }
  }
}

export function clearGalleryAuthorization(
  cacheNamespace: string,
  reason: PhoneGalleryClearedDetail['reason'],
): void {
  // Settings can disconnect a cold native job before Journal ever mounts.
  cancelNativeGalleryScan(cacheNamespace)
  authorizations.delete(cacheNamespace)
  // Small, memory-only cache: clear synchronously before notifying image consumers.
  cache.clear()
  cacheBytes = 0
  cacheGeneration += 1
  pendingReads.clear()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<PhoneGalleryClearedDetail>(PHONE_GALLERY_CLEARED_EVENT, {
      detail: { cacheNamespace, reason },
    }))
  }
}

function requireAuthorized(source: string, cacheNamespace: string) {
  if (!authorizations.get(cacheNamespace)?.has(source)) {
    throw new Error('Connect this account’s phone gallery to view this photo.')
  }
}

async function acquireReadSlot(): Promise<void> {
  if (runningReads < 4) { runningReads += 1; return }
  if (waitingReads.length >= 200) throw new Error('Too many photos are loading. Try again shortly.')
  await new Promise<void>((resolve) => waitingReads.push(resolve))
}

function releaseReadSlot(): void {
  const next = waitingReads.shift()
  if (next) next()
  else runningReads -= 1
}

function remember(key: string, dataUrl: string) {
  const previous = cache.get(key)
  if (previous) { cacheBytes -= previous.length * 2; cache.delete(key) }
  const size = dataUrl.length * 2
  if (size > MAX_CACHE_BYTES) return
  while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + size > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cacheBytes -= (cache.get(oldest)?.length ?? 0) * 2
    cache.delete(oldest)
  }
  cache.set(key, dataUrl)
  cacheBytes += size
}

/** Reads a bounded JPEG only when a connected account currently authorizes this exact source. */
export async function readGalleryPhotoSource(source: string, maxDimension = 1024): Promise<string> {
  const { nativeId, cacheNamespace } = parseSource(source)
  if (!isPhoneGallerySupported()) throw new Error('Phone gallery access is unavailable on this device.')
  requireAuthorized(source, cacheNamespace)
  const size = Math.max(256, Math.min(1600, Number.isFinite(maxDimension) ? Math.round(maxDimension) : 1024))
  const key = `${source}\u0000${size}`
  const existing = pendingReads.get(key)
  if (existing) return existing
  const generation = cacheGeneration
  const read = (async () => {
    await acquireReadSlot()
    try {
      requireAuthorized(source, cacheNamespace)
      const permission = (await PhoneGallery.getPermission()).status
      if (permission !== 'granted' && permission !== 'limited') {
        clearGalleryAuthorization(cacheNamespace, 'permission')
        throw new Error('Photo permission is no longer available. Reconnect your phone gallery.')
      }
      requireAuthorized(source, cacheNamespace)
      if (generation !== cacheGeneration) throw new Error('Phone photo access changed.')
      // Limited access can remove a single asset without changing the overall
      // permission status. Native readPhoto revalidates that exact asset grant.
      const cached = permission === 'granted' ? cache.get(key) : undefined
      if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        return cached
      }
      const { dataUrl } = await PhoneGallery.readPhoto({ id: nativeId, maxDimension: size })
      requireAuthorized(source, cacheNamespace)
      if (generation !== cacheGeneration) throw new Error('Phone photo access changed.')
      if (typeof dataUrl !== 'string' || dataUrl.length > MAX_JPEG_CHARACTERS
        || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl)) {
        throw new Error('The phone returned an invalid photo preview.')
      }
      remember(key, dataUrl)
      return dataUrl
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'PERMISSION_DENIED') {
        clearGalleryAuthorization(cacheNamespace, 'permission')
      }
      throw error
    } finally { releaseReadSlot() }
  })()
  pendingReads.set(key, read)
  try { return await read }
  finally { if (pendingReads.get(key) === read) pendingReads.delete(key) }
}
