import { useEffect, useRef, useState } from 'react'
import type { CapsuleImageSource } from '../../capsules/types'

type TimelinePhotoImageProps = {
  source: CapsuleImageSource
  alt: string
  width?: number
  height?: number
  lazy?: boolean
}

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

  useEffect(() => {
    const objectUrl = URL.createObjectURL(source)
    if (imageRef.current) imageRef.current.src = objectUrl
    return () => URL.revokeObjectURL(objectUrl)
  }, [source])

  if (failedSource === source) return <UnavailablePhoto alt={alt} />
  return (
    <img
      ref={imageRef}
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

export function TimelinePhotoImage({
  source,
  alt,
  width,
  height,
  lazy = false,
}: TimelinePhotoImageProps) {
  return typeof source === 'string'
    ? <StringPhoto source={source} alt={alt} width={width} height={height} lazy={lazy} />
    : <BlobPhoto source={source} alt={alt} width={width} height={height} lazy={lazy} />
}
