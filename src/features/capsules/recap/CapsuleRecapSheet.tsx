import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CapsulePhotoImage } from '../CapsulePhotoImage'
import { CapsuleContributorBadge } from '../CapsuleContributorBadge'
import { capsuleDisplayTitle, capsuleRecapPhotos } from '../capsuleViewModel'
import type { CapsuleImageSource, CapsulePhoto, FamilyCapsule } from '../types'
import { capsuleRecapFileExtension, renderBrowserCapsuleRecap } from './browserCapsuleRecap'
import {
  discardNativeCapsuleRecapArtifacts,
  isNativeCapsuleRecapAvailable,
  renderNativeCapsuleRecap,
  shareNativeCapsuleRecap,
  stageNativeCapsuleRecapImage,
} from './nativeCapsuleRecap'
import { buildCapsuleRecapPlan, CAPSULE_RECAP_PHOTO_DURATION_MS, orderCapsuleRecapPhotos } from './recapPlan'
import { prepareAttributedRecapFrame } from './recapAttribution'

type CapsuleRecapSheetProps = {
  capsule: FamilyCapsule
  demoMode: boolean
  onClose: () => void
  onPreparePhotos: () => Promise<CapsulePhoto[]>
  onPlaybackReady?: () => void
}

/** Materializes a signed or local image source for native recap staging. */
async function imageSourceToBlob(source: CapsuleImageSource) {
  if (typeof source !== 'string') return source
  const response = await fetch(source)
  if (!response.ok) throw new Error('One of the Capsule photos could not be opened.')
  return response.blob()
}

/** Encodes a Blob for the JSON-only Capacitor bridge. */
function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('One of the Capsule photos could not be prepared.'))
    reader.onerror = () => reject(reader.error ?? new Error('One of the Capsule photos could not be prepared.'))
    reader.readAsDataURL(blob)
  })
}

/** Plays an opened Capsule and coordinates native-first video export with cleanup. */
export function CapsuleRecapSheet({
  capsule,
  demoMode,
  onClose,
  onPreparePhotos,
  onPlaybackReady,
}: CapsuleRecapSheetProps) {
  const orderedPhotos = useMemo(
    () => orderCapsuleRecapPhotos(capsuleRecapPhotos(capsule.photos)),
    [capsule.photos],
  )
  const displayTitle = capsuleDisplayTitle(capsule)
  const [index, setIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const saveInFlightRef = useRef(false)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Recap playback is a lightweight slideshow; the same duration constant also
  // drives exported frame plans so the preview and saved video feel consistent.
  useEffect(() => {
    if (orderedPhotos.length < 2) return
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % orderedPhotos.length),
      CAPSULE_RECAP_PHOTO_DURATION_MS,
    )
    return () => window.clearInterval(timer)
  }, [orderedPhotos.length])

  // The recap is portalled outside the app shell. Own focus containment here
  // and restore the exact invoking control when the portal unmounts.
  useEffect(() => {
    const dialog = dialogRef.current
    const returnTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusableElements = () => dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>([
          'a[href]',
          'button:not([disabled])',
          'input:not([disabled])',
          'select:not([disabled])',
          'textarea:not([disabled])',
          '[tabindex]:not([tabindex="-1"])',
        ].join(','))).filter((element) => element.getAttribute('aria-hidden') !== 'true')
      : []

    closeButtonRef.current?.focus({ preventScroll: true })

    // Keeps keyboard focus inside the recap portal and lets Escape close it.
    function containDialogFocus(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = focusableElements()
      if (focusable.length === 0) {
        event.preventDefault()
        dialog?.focus({ preventScroll: true })
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const focusIsOutside = !active || !dialog?.contains(active)
      if (event.shiftKey && (active === first || focusIsOutside)) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === last || focusIsOutside)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', containDialogFocus, true)
    return () => {
      document.removeEventListener('keydown', containDialogFocus, true)
      if (returnTarget?.isConnected) {
        returnTarget.focus({ preventScroll: true })
      }
    }
  }, [])

  // Exports one stable photo snapshot, preferring native video generation and
  // cleaning every temporary artifact before any browser fallback.
  async function saveRecap() {
    // React state disables the button on the next render, but two synthetic or
    // assistive-technology activations can arrive in the same JavaScript turn.
    // The ref is a synchronous mutex so only one native render/download owns
    // temporary artifacts at a time.
    if (saveInFlightRef.current) return
    saveInFlightRef.current = true
    setSaving(true)
    setStatus('Making your video…')
    const nativeArtifacts: string[] = []
    let nativeFailure: unknown
    try {
      /*
       * Re-read the snapshot immediately before export so a recap includes
       * uploads restored from IndexedDB or just acknowledged by family sync.
       * Native rendering is preferred because it can create and share an MP4
       * without loading every full-size frame into a WebView canvas. Its staged
       * images and rendered file are private temporaries and are discarded on
       * success, failure, and before falling back to the browser renderer.
       */
      const preparedPhotos = orderCapsuleRecapPhotos(capsuleRecapPhotos(await onPreparePhotos()))
      if (preparedPhotos.length === 0) {
        throw new Error('These Capsule photos are not available on this phone yet.')
      }
      if (capsule.familySynced && preparedPhotos.length < (capsule.totalPhotoCount ?? 0)) {
        throw new Error('Some family photos are still syncing. Reconnect before saving the combined recap.')
      }
      // Validate before staging any image: never export a silently truncated film.
      buildCapsuleRecapPlan(preparedPhotos)
      if (isNativeCapsuleRecapAvailable()) {
        try {
          const imagePaths: string[] = []
          for (const photo of preparedPhotos) {
            const blob = await imageSourceToBlob(photo.image)
            const attributedFrame = await prepareAttributedRecapFrame(blob, photo)
            const dataUrl = await blobToDataUrl(attributedFrame)
            const staged = await stageNativeCapsuleRecapImage({ dataUrl })
            imagePaths.push(staged.path)
            nativeArtifacts.push(staged.path)
          }
          const video = await renderNativeCapsuleRecap({ imagePaths })
          nativeArtifacts.push(video.fileUri)
          const share = await shareNativeCapsuleRecap(video.fileUri)
          setStatus(share.completed ? 'Your recap is ready to save or share.' : 'Your recap is ready whenever you are.')
          return
        } catch (reason) {
          nativeFailure = reason
          // A device codec or share service can occasionally be unavailable.
          // Release private native artifacts before attempting the existing
          // browser renderer rather than leaving the feature at a dead end.
          await discardNativeCapsuleRecapArtifacts(nativeArtifacts).catch(() => undefined)
          nativeArtifacts.length = 0
          setStatus('Native video export was unavailable. Trying the compatible fallback…')
        }
      }

      let video: Blob
      try {
        video = await renderBrowserCapsuleRecap(preparedPhotos)
      } catch (fallbackFailure) {
        if (!nativeFailure) throw fallbackFailure
        const nativeMessage = nativeFailure instanceof Error
          ? nativeFailure.message
          : 'Native video export failed.'
        const fallbackMessage = fallbackFailure instanceof Error
          ? fallbackFailure.message
          : 'The compatible video fallback failed.'
        throw new Error(`${nativeMessage} ${fallbackMessage}`)
      }
      const objectUrl = URL.createObjectURL(video)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = `${displayTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'family-capsule'}.${capsuleRecapFileExtension(video)}`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
      setStatus('Your recap is ready in Downloads.')
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'The recap could not be saved.')
    } finally {
      await discardNativeCapsuleRecapArtifacts(nativeArtifacts).catch(() => undefined)
      saveInFlightRef.current = false
      setSaving(false)
    }
  }

  const activePhoto = orderedPhotos.length > 0 ? orderedPhotos[index % orderedPhotos.length] : undefined
  return createPortal(
    <div
      ref={dialogRef}
      className="capsule-recap-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="capsule-recap-title"
      tabIndex={-1}
    >
      <section className="capsule-recap-sheet__panel">
        <header>
          <div>
            <p>{demoMode ? 'Demo preview' : 'Family recap'}</p>
            <h2 id="capsule-recap-title">{displayTitle}</h2>
          </div>
          <button ref={closeButtonRef} type="button" aria-label="Close recap" onClick={onClose}>×</button>
        </header>

        <div className="capsule-recap-player" aria-live="off">
          {activePhoto ? (
            <CapsulePhotoImage
              source={activePhoto.image}
              alt={activePhoto.caption || `Photo from ${activePhoto.contributorName}`}
              onReady={onPlaybackReady}
            />
          ) : null}
          {activePhoto ? <CapsuleContributorBadge name={activePhoto.contributorName} avatarUrl={activePhoto.contributorAvatarUrl} /> : null}
          <span className="capsule-recap-player__credit">{activePhoto?.contributorName}</span>
        </div>

        <div className="capsule-recap-progress" aria-hidden="true">
          {orderedPhotos.map((photo, photoIndex) => (
            <span key={photo.id} data-active={photoIndex === index % orderedPhotos.length ? 'true' : 'false'} />
          ))}
        </div>

        <button className="ks-primary-button capsule-recap-save" type="button" disabled={saving} onClick={() => void saveRecap()}>
          {saving ? 'Making video…' : 'Save video'}
        </button>
        <p className="capsule-recap-sheet__status" role="status" aria-live="polite">{status}</p>
      </section>
    </div>,
    document.body,
  )
}
