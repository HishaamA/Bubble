import { useEffect, useMemo, useState } from 'react'
import type { CapsuleImageSource } from '../capsules/types'

type CapsulePhotoImageProps = {
  source: CapsuleImageSource
  alt: string
  className?: string
}

function ImageElement({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  if (failed || !src) {
    return (
      <span
        className={`${className ?? ''} journal-photo-placeholder`.trim()}
        role="img"
        aria-label={`${alt}. Photo preview unavailable.`}
      >
        <span aria-hidden="true">✦</span>
      </span>
    )
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      draggable="false"
      onError={() => setFailed(true)}
    />
  )
}

function BlobImage({
  source,
  alt,
  className,
}: CapsulePhotoImageProps & { source: Blob }) {
  const objectUrl = useMemo(() => URL.createObjectURL(source), [source])
  useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl])
  return (
    <ImageElement
      key={objectUrl}
      src={objectUrl}
      alt={alt}
      className={className}
    />
  )
}

export function CapsulePhotoImage({
  source,
  alt,
  className,
}: CapsulePhotoImageProps) {
  if (typeof source === 'string') {
    const usableSource = source.startsWith('blob:') ? '' : source
    return (
      <ImageElement
        key={usableSource}
        src={usableSource}
        alt={alt}
        className={className}
      />
    )
  }
  return <BlobImage source={source} alt={alt} className={className} />
}
