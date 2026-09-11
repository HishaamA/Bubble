import type { CapsuleImageSource } from '../capsules/types'

/** A renewed Storage signature is not a new photo. Keep all image transforms. */
export function widgetThumbnailCacheKey(source: CapsuleImageSource): CapsuleImageSource {
  if (typeof source !== 'string') return source
  try {
    const url = new URL(source)
    if (/^https?:$/.test(url.protocol) && url.pathname.startsWith('/storage/v1/object/sign/')) {
      url.searchParams.delete('token')
      return url.toString()
    }
  } catch {
    // Data URLs, blobs and ordinary sources retain their exact identities.
  }
  return source
}
