import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import type { CapsuleImageSource } from '../../capsules/types'
import { acquireTimelinePhotoPreview, peekTimelinePhotoPreview } from './timelinePhotoPreviewCache'
import { GalleryPhotoImage } from '../GalleryPhotoImage'
import { isGalleryPhotoSource } from '../gallery/phoneGallery'

const PreviewNamespace = createContext<string | null>(null)

/** Limits warm photo URLs to the active account/family, never persisted storage. */
export function TimelinePhotoPreviewScope({ namespace, children }: PropsWithChildren<{ namespace: string }>) {
  return <PreviewNamespace.Provider value={namespace}>{children}</PreviewNamespace.Provider>
}

type TimelinePhotoImageProps = {
  source: CapsuleImageSource
  alt: string
  width?: number
  height?: number
  lazy?: boolean
}

/** Supplies an accessible fallback when a timeline preview cannot load. */
function UnavailablePhoto({ alt }: { alt: string }) {
  return (
    <span className="people-timeline__photo-unavailable" role="img" aria-label={`${alt}. Preview unavailable.`}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5.5 8.5h21v15h-21zM8 20l5-5 3.4 3.4 2.6-2.6 5 5.2M21 12.2h.01" />
      </svg>
      <span>Preview unavailable</span>
    </span>
  )
}

/** Tracks failures per URL so a newly refreshed signed URL can retry. */
function StringPhoto({
  source,
  alt,
  width,
  height,
  lazy,
}: {
  source: string
  alt: string
  width?: number
  height?: number
  lazy?: boolean
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  if (!source || failedSource === source) return <UnavailablePhoto alt={alt} />
  return (
    <img
      className="people-timeline__photo-image"
      src={source}
      alt={alt}
      width={width}
      height={height}
      loading={lazy ? 'lazy' : undefined}
      decoding={lazy ? 'async' : undefined}
      draggable="false"
      onError={() => setFailedSource(source)}
    />
  )
}

/** Bridges a durable Blob to an image element without persisting its object URL. */
function BlobPhoto({
  source,
  alt,
  width,
  height,
  lazy,
}: {
  source: Blob
  alt: string
  width?: number
  height?: number
  lazy?: boolean
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [failedSource, setFailedSource] = useState<Blob | null>(null)
  const namespace = useContext(PreviewNamespace)
  const warmUrl = namespace ? peekTimelinePhotoPreview(namespace, source) : undefined

  useEffect(() => {
    if (namespace) {
      const preview = acquireTimelinePhotoPreview(namespace, source)
      if (imageRef.current) imageRef.current.src = preview.url
      return preview.release
    }
    // Standalone images still own their URL. Scoped Journal images reuse a
    // bounded warm preview across route changes; neither path allocates in render.
    const objectUrl = URL.createObjectURL(source)
    if (imageRef.current) imageRef.current.src = objectUrl
    return () => URL.revokeObjectURL(objectUrl)
  }, [namespace, source])

  if (failedSource === source) return <UnavailablePhoto alt={alt} />
  return (
    <img
      ref={imageRef}
      src={warmUrl}
      className="people-timeline__photo-image"
      alt={alt}
      width={width}
      height={height}
      loading={lazy ? 'lazy' : undefined}
      decoding={lazy ? 'async' : undefined}
      draggable="false"
      onError={() => setFailedSource(source)}
    />
  )
}

/** Renders a thumbnail with bounded session reuse or standalone URL ownership. */
export function TimelinePhotoImage({
  source,
  alt,
  width,
  height,
  lazy = false,
}: TimelinePhotoImageProps) {
  if (isGalleryPhotoSource(source)) return <GalleryPhotoImage key={source} source={source} alt={alt}
    width={width} height={height} lazy={lazy} className="people-timeline__photo-image" />
  return typeof source === 'string'
    ? <StringPhoto source={source} alt={alt} width={width} height={height} lazy={lazy} />
    : <BlobPhoto source={source} alt={alt} width={width} height={height} lazy={lazy} />
}
