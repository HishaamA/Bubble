import { FacePhotoPipelineError } from '../features/journal/people/faceRecognitionPipeline'
import type { StoredPhotoFaceScan } from '../features/journal/people/types'
import {
  GalleryFaceRuntimeError,
  scanGalleryPhoto,
} from './galleryFaceScannerRuntime'

export type GalleryScanRequest = {
  token: string
  key: string
  nativeId: string
}

export type BubbleGalleryHost = {
  ready: () => void
  complete: (token: string, jsonStoredPhotoFaceScan: string) => void
  failed: (token: string, reason: string) => void
}

export type BubbleGalleryEngine = {
  scan: (request: unknown) => void
}

type GalleryScannerTarget = {
  BubbleGalleryEngine?: BubbleGalleryEngine
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POSITIVE_MEDIA_ID = /^[1-9][0-9]{0,18}$/
const MAX_SIGNED_LONG = '9223372036854775807'
const GALLERY_KEY_PREFIX = 'journal-photo:device-gallery:'
const MAX_RESULT_JSON_LENGTH = 700_000

function callbackToken(request: unknown) {
  if (!request || typeof request !== 'object') return ''
  const token = Reflect.get(request, 'token')
  return typeof token === 'string' && token.length <= 128 ? token : ''
}

function isPositiveSignedLong(value: string) {
  return POSITIVE_MEDIA_ID.test(value) &&
    (value.length < MAX_SIGNED_LONG.length || value <= MAX_SIGNED_LONG)
}

/** Rejects unexpected native input before it can be interpolated into a URL. */
export function validateGalleryScanRequest(
  request: unknown,
): GalleryScanRequest | null {
  if (!request || typeof request !== 'object') return null
  const token = Reflect.get(request, 'token')
  const key = Reflect.get(request, 'key')
  const nativeId = Reflect.get(request, 'nativeId')
  if (
    typeof token !== 'string' ||
    !UUID.test(token) ||
    typeof nativeId !== 'string' ||
    !isPositiveSignedLong(nativeId) ||
    typeof key !== 'string' ||
    key.length > 2048 ||
    !key.startsWith(`${GALLERY_KEY_PREFIX}${nativeId}:`) ||
    [...key].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return null
  }
  return { token, key, nativeId }
}

function failureReason(error: unknown) {
  if (error instanceof GalleryFaceRuntimeError) return 'runtime:unavailable'
  if (error instanceof FacePhotoPipelineError) return 'photo:scan-failed'
  return 'runtime:unexpected'
}

/** Installs the deliberately tiny native bridge API and admits one photo at a time. */
export function installGalleryScannerEngine(
  target: GalleryScannerTarget,
  host: BubbleGalleryHost,
  scanPhoto: (nativeId: string) => Promise<StoredPhotoFaceScan> = scanGalleryPhoto,
) {
  let activeToken: string | null = null

  const engine: BubbleGalleryEngine = {
    scan(input) {
      const request = validateGalleryScanRequest(input)
      if (!request) {
        host.failed(callbackToken(input), 'request:invalid')
        return
      }
      if (activeToken !== null) {
        host.failed(request.token, 'engine:busy')
        return
      }
      activeToken = request.token
      void scanPhoto(request.nativeId).then(
        (scan) => {
          let json: string
          try {
            json = JSON.stringify(scan)
          } catch {
            host.failed(request.token, 'runtime:unexpected')
            return
          }
          if (json.length > MAX_RESULT_JSON_LENGTH) {
            host.failed(request.token, 'result:too-large')
          } else {
            host.complete(request.token, json)
          }
        },
        (error: unknown) => host.failed(request.token, failureReason(error)),
      ).finally(() => {
        if (activeToken === request.token) activeToken = null
      })
    },
  }

  target.BubbleGalleryEngine = engine
  host.ready()
  return engine
}

declare global {
  interface Window {
    BubbleGalleryEngine?: BubbleGalleryEngine
    BubbleGalleryHost?: BubbleGalleryHost
  }
}
