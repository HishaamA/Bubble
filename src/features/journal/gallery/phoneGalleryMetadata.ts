import { makeGalleryPhotoSource } from './phoneGallery'
import type { NativePhoneGalleryPhoto, PhoneGalleryAsset, PhoneGalleryPermission } from './phoneGallery'

const PREFIX = 'bubble:phone-gallery:v1:'

export function galleryMetadataKey(cacheNamespace: string): string {
  return `${PREFIX}${encodeURIComponent(cacheNamespace)}`
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

/** Explicit whitelist: plugin extras can never persist binary data or upload state. */
export function normalizeGalleryPhoto(raw: NativePhoneGalleryPhoto, cacheNamespace: string): PhoneGalleryAsset | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id
    || raw.id.length > 2048 || [...raw.id].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })) return null
  const capturedAt = iso(raw.capturedAt)
  if (!capturedAt || !Number.isFinite(raw.width) || raw.width <= 0
    || !Number.isFinite(raw.height) || raw.height <= 0) return null
  const modifiedAt = iso(raw.modifiedAt)
  return {
    id: `device-gallery:${encodeURIComponent(raw.id)}`,
    nativeId: raw.id,
    source: makeGalleryPhotoSource(raw.id, cacheNamespace, modifiedAt),
    capturedAt,
    width: Math.round(raw.width), height: Math.round(raw.height),
    filename: typeof raw.filename === 'string' ? raw.filename.slice(0, 512) : 'Phone photo',
    ...(modifiedAt ? { modifiedAt } : {}),
  }
}

type GalleryScope = Extract<PhoneGalleryPermission, 'granted' | 'limited'>
export type GalleryMetadata = {
  enabled: boolean
  setupComplete: boolean
  setupPersisted: boolean
  photos: PhoneGalleryAsset[]
  revision?: string
  permission?: GalleryScope
}
type SaveGalleryOptions = { setupComplete?: boolean; revision?: string; permission?: GalleryScope }
function validRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

export function loadGalleryMetadata(cacheNamespace: string): GalleryMetadata {
  const empty = { enabled: false, setupComplete: false, setupPersisted: false, photos: [] }
  try {
    const raw = JSON.parse(localStorage.getItem(galleryMetadataKey(cacheNamespace)) ?? 'null')
    if (raw?.version !== 1 && raw?.version !== 2) return empty
    const enabled = raw.enabled === true
    const setupComplete = enabled || raw.setupComplete === true
    if (!enabled) return { ...empty, setupComplete, setupPersisted: setupComplete }
    const input = Array.isArray(raw.photos) ? raw.photos : []
    const normalized = input.map((photo: NativePhoneGalleryPhoto) => normalizeGalleryPhoto(photo, cacheNamespace))
      .filter((photo: PhoneGalleryAsset | null): photo is PhoneGalleryAsset => photo !== null)
    const photos = [...new Map<string, PhoneGalleryAsset>(normalized.map((photo: PhoneGalleryAsset) => [photo.id, photo])).values()]
    const complete = raw.version === 2 && Array.isArray(raw.photos) && normalized.length === input.length
      && photos.length === input.length && raw.indexComplete === true && validRevision(raw.revision)
      && (raw.permission === 'granted' || raw.permission === 'limited')
    return { enabled, setupComplete, setupPersisted: setupComplete, photos,
      ...(complete ? { revision: raw.revision, permission: raw.permission } : {}) }
  } catch { return empty }
}

export function saveGalleryMetadata(
  cacheNamespace: string, enabled: boolean, photos: readonly PhoneGalleryAsset[], options: SaveGalleryOptions = {},
): { setupPersisted: boolean; indexPersisted: boolean } {
  try {
    const key = galleryMetadataKey(cacheNamespace)
    const setupComplete = enabled || options.setupComplete !== false
    const choice = { version: 2, enabled, setupComplete }
    const complete = enabled && validRevision(options.revision)
      && (options.permission === 'granted' || options.permission === 'limited')
    const metadata = enabled ? photos.map((photo) => ({
      id: photo.nativeId, capturedAt: photo.capturedAt,
      width: photo.width, height: photo.height, filename: photo.filename,
      ...(photo.modifiedAt ? { modifiedAt: photo.modifiedAt } : {}),
    })) : []
    try {
      localStorage.setItem(key, JSON.stringify({ ...choice, photos: metadata, indexComplete: complete,
        ...(complete ? { revision: options.revision, permission: options.permission } : {}) }))
      return { setupPersisted: setupComplete, indexPersisted: !enabled || complete }
    }
    catch {
      // Remember the choice on quota failure, but never claim an empty fallback
      // is a complete, reusable native index.
      localStorage.setItem(key, JSON.stringify({ ...choice, photos: [], indexComplete: false }))
      return { setupPersisted: setupComplete, indexPersisted: !enabled }
    }
  } catch {
    // Storage-disabled WebViews still support this explicit, current-session consent.
    // If a disconnect cannot be saved, at least try to remove the older opt-in
    // so a later launch cannot silently restore the choice the user revoked.
    if (!enabled) {
      try { localStorage.removeItem(galleryMetadataKey(cacheNamespace)) } catch { /* Storage may be fully unavailable. */ }
    }
    return { setupPersisted: false, indexPersisted: false }
  }
}
