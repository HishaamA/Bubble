import { useEffect, useRef, useState } from 'react'
import { PHONE_GALLERY_CLEARED_EVENT, readGalleryPhotoSource, type PhoneGalleryClearedDetail } from './gallery/phoneGallery'

type GalleryPhotoImageProps = {
  source: string; alt: string; className?: string; width?: number; height?: number; lazy?: boolean
}

/** A changed gallery reference starts a new permission/read lifecycle, including after failure. */
export function GalleryPhotoImage(props: GalleryPhotoImageProps) {
  return <GalleryPhotoPreview key={props.source} {...props} />
}

/** Requests a bounded in-memory preview only when it is needed on screen. */
function GalleryPhotoPreview({ source, alt, className, width, height, lazy = false }: GalleryPhotoImageProps) {
  const element = useRef<HTMLImageElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    let observer: IntersectionObserver | undefined
    const image = element.current
    // A fresh source owns a fresh native permission check. Bytes never enter storage.
    const load = () => {
      void readGalleryPhotoSource(source, lazy ? 512 : 1280).then((dataUrl) => {
        if (!cancelled && image) image.src = dataUrl
      }).catch(() => { if (!cancelled) setFailed(true) })
    }
    const clear = (event: Event) => {
      const detail = (event as CustomEvent<PhoneGalleryClearedDetail>).detail
      const scope = new URLSearchParams(source.split('?')[1]).get('scope')
      if (detail?.cacheNamespace !== scope) return
      cancelled = true
      observer?.disconnect()
      image?.removeAttribute('src')
      setFailed(true)
    }
    window.addEventListener(PHONE_GALLERY_CLEARED_EVENT, clear)
    if (lazy && image && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some(({ isIntersecting }) => isIntersecting)) { observer?.disconnect(); load() }
      }, { rootMargin: '200px' })
      observer.observe(image)
    } else load()
    return () => {
      cancelled = true
      observer?.disconnect()
      image?.removeAttribute('src')
      window.removeEventListener(PHONE_GALLERY_CLEARED_EVENT, clear)
    }
  }, [lazy, source])
  if (failed) return <span className={`${className ?? ''} people-timeline__photo-unavailable`} role="img" aria-label={`${alt}. Photo unavailable. Check gallery access.`}>Photo unavailable</span>
  return <img ref={element} className={className} alt={alt} width={width} height={height}
    decoding="async" draggable="false" onError={() => setFailed(true)} />
}
