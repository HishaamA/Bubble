import { useEffect, useState } from 'react'
import type { CapsuleImageSource } from './types'

type CapsulePhotoImageProps = {
  source: CapsuleImageSource
  alt: string
  onReady?: () => void
}

/** Renders string or Blob media while owning and revoking any object URL it creates. */
export function CapsulePhotoImage({
  source,
  alt,
  onReady,
}: CapsulePhotoImageProps) {
  const [blobPreview, setBlobPreview] = useState<{
    source: Blob
    url: string
  } | null>(null)
  const [loadedSource, setLoadedSource] = useState<CapsuleImageSource | null>(null)
  const [failedSource, setFailedSource] = useState<CapsuleImageSource | null>(null)

  useEffect(() => {
    if (typeof source === 'string' || typeof URL.createObjectURL !== 'function') return

    // This component, and only this component instance, owns the URL created
    // for an IndexedDB Blob. Object URLs are process-local capabilities, so we
    // never write them back to the Capsule store and always revoke them when
    // either the Blob changes or its preview leaves the tree.
    const objectUrl = URL.createObjectURL(source)
    // oxlint-disable-next-line react/set-state-in-effect -- Blob URLs are external browser resources created and released with this effect.
    setBlobPreview({ source, url: objectUrl })
    return () => URL.revokeObjectURL?.(objectUrl)
  }, [source])

  const legacyObjectUrl = typeof source === 'string' && source.startsWith('blob:')
  const src = typeof source === 'string'
    ? legacyObjectUrl ? '' : source
    : blobPreview?.source === source ? blobPreview.url : ''
  const failed = legacyObjectUrl || failedSource === source
  const loaded = loadedSource === source

  if (!src || failed) {
    return (
      <span
        className="capsule-photo-placeholder"
        role="img"
        aria-label={`${alt}. Preview unavailable until Bubble reconnects.`}
      >
        <span aria-hidden="true">✦</span>
      </span>
    )
  }

  return (
    <span className="capsule-photo-media" data-ready={loaded ? 'true' : 'false'}>
      <img
        src={src}
        alt={alt}
        aria-hidden={loaded ? undefined : 'true'}
        draggable="false"
        onLoad={() => {
          setLoadedSource(source)
          onReady?.()
        }}
        onError={() => setFailedSource(source)}
      />
      {!loaded ? (
        <span
          className="capsule-photo-placeholder"
          role="img"
          aria-label={`${alt}. Loading preview.`}
        >
          <span aria-hidden="true">✦</span>
        </span>
      ) : null}
    </span>
  )
}
