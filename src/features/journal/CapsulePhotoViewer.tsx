import { useEffect, useMemo, useRef } from 'react'
import {
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { Icon } from '../../components/Icon'
import type { FamilyCapsule } from '../capsules/types'
import { CapsulePhotoImage } from './CapsulePhotoImage'
import { unlockedCapsulePhotos } from './capsuleJournalArchive'
import { journalPhotoAsUnlocked } from './journalPhotoLibrary'
import {
  JOURNAL_LIBRARY_ID,
  type JournalPhoto,
} from './journalPhotoTypes'
import './CapsulePhotoViewer.css'

type JournalViewerState = {
  returnTo?: string
  journalContext?: {
    section?: string
    personId?: string
    selectedDayKey?: string
    view?: 'grid'
    scrollTop?: number
    weekOffset?: number
    focusMemoryId?: string
  }
}

type CapsulePhotoViewerProps = {
  capsules: FamilyCapsule[]
  loading?: boolean
  now?: Date
  journalPhotos?: readonly JournalPhoto[]
}

/** Derives a short, stable avatar label from a contributor display name. */
function initials(name: string) {
  const value = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
  return value || 'F'
}

/** Formats a valid capture timestamp and supplies safe copy for corrupt data. */
function capturedDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Family memory'
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

/** Compares local calendar days without allowing invalid timestamps to match. */
function sameCapturedDay(left: string, right: string) {
  const first = new Date(left)
  const second = new Date(right)
  return Number.isFinite(first.getTime()) && Number.isFinite(second.getTime()) &&
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
}

/**
 * Presents one unlocked photo with keyboard navigation, focus containment, and
 * an optional jump into the matching panorama memory.
 */
export function CapsulePhotoViewer({
  capsules,
  loading = false,
  now = new Date(),
  journalPhotos = [],
}: CapsulePhotoViewerProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { capsuleId = '', photoId = '' } = useParams()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const routeState = location.state as JournalViewerState | null
  const requestedCapsuleId = capsuleId || (
    location.pathname.startsWith('/journal/library/')
      ? JOURNAL_LIBRARY_ID
      : ''
  )
  const unlockedPhotos = useMemo(
    // Build one feed from opened capsules and direct journal uploads. Sealed
    // media is excluded before route lookup so a guessed URL cannot reveal it.
    () => [
      ...unlockedCapsulePhotos(capsules, now),
      ...journalPhotos.map(journalPhotoAsUnlocked),
    ],
    [capsules, journalPhotos, now],
  )
  const requestedPhoto = unlockedPhotos.find((photo) =>
    photo.capsuleId === requestedCapsuleId && photo.id === photoId,
  )
  // Paging stays within the captured day that launched the viewer. Returning
  // therefore restores the same timeline group rather than jumping albums.
  const photos = requestedPhoto
    ? unlockedPhotos.filter((photo) =>
        sameCapturedDay(photo.capturedAt, requestedPhoto.capturedAt),
      )
    : unlockedPhotos
  const activeIndex = photos.findIndex((photo) =>
    photo.capsuleId === requestedCapsuleId && photo.id === photoId,
  )
  const photo = activeIndex >= 0 ? photos[activeIndex] : undefined

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      titleRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [photo?.id])

  /** Leaves the modal viewer while preserving the originating timeline context. */
  function returnToJournal() {
    navigate('/journal', {
      replace: true,
      state: { journalContext: routeState?.journalContext },
      viewTransition: true,
    })
  }

  /** Replaces the current route with an adjacent photo from the same day. */
  function openAdjacentPhoto(nextIndex: number) {
    const nextPhoto = photos[nextIndex]
    if (!nextPhoto) return
    const nextMemoryId = nextPhoto.capsuleId === JOURNAL_LIBRARY_ID
      ? `journal-photo-${nextPhoto.id}`
      : `capsule-${nextPhoto.capsuleId}-${nextPhoto.id}`
    // Replace rather than push: Previous/Next is one viewer session, so the
    // device Back gesture should leave the viewer instead of replaying photos.
    const nextState: JournalViewerState = {
      ...(routeState ?? { returnTo: '/journal' }),
      journalContext: {
        ...routeState?.journalContext,
        focusMemoryId: nextMemoryId,
      },
    }
    navigate(
      nextPhoto.capsuleId === JOURNAL_LIBRARY_ID
        ? `/journal/library/${encodeURIComponent(nextPhoto.id)}`
        : `/journal/photo/${encodeURIComponent(nextPhoto.capsuleId)}/${encodeURIComponent(nextPhoto.id)}`,
      {
        replace: true,
        state: nextState,
        viewTransition: true,
      },
    )
  }

  if (loading && !photo) {
    return (
      <section className="journal-photo-viewer journal-photo-viewer--status">
        <p role="status">Opening your family photo…</p>
        <button type="button" onClick={returnToJournal}>Back to Journal</button>
      </section>
    )
  }

  if (!photo) {
    const isLibraryPhoto = requestedCapsuleId === JOURNAL_LIBRARY_ID
    return (
      <section className="journal-photo-viewer journal-photo-viewer--status">
        <p className="journal-photo-viewer__eyebrow">{isLibraryPhoto ? 'Family photos' : 'Capsule memory'}</p>
        <h1 ref={titleRef} tabIndex={-1}>
          {isLibraryPhoto
            ? 'This family photo is unavailable.'
            : 'This photo is still sealed or unavailable.'}
        </h1>
        <p>
          {isLibraryPhoto
            ? 'It may still be loading from this device or your family library.'
            : 'It will appear in Journal only after its Capsule opens.'}
        </p>
        <button type="button" onClick={returnToJournal}>Back to Journal</button>
      </section>
    )
  }

  const title = photo.caption.trim() || photo.capsuleTitle

  return (
    <section
      className="journal-photo-viewer"
      aria-labelledby="journal-photo-title"
    >
      <header className="journal-photo-viewer__bar">
        <button
          type="button"
          className="journal-photo-viewer__back"
          aria-label="Back to Journal"
          onClick={returnToJournal}
        >
          <Icon name="arrow" size={22} />
        </button>
        <div>
          <p>{photo.capsuleTitle}</p>
          <h1 id="journal-photo-title" ref={titleRef} tabIndex={-1}>
            Photo memory
          </h1>
        </div>
        <button
          type="button"
          className="journal-photo-viewer__close"
          aria-label="Close photo and return to Journal"
          onClick={returnToJournal}
        >
          ×
        </button>
      </header>

      <div className="journal-photo-viewer__feed">
        <article className="journal-photo-post">
          <header className="journal-photo-post__person">
            <span aria-hidden="true">{initials(photo.contributorName)}</span>
            <div>
              <strong>{photo.contributorName}</strong>
              <small>{capturedDate(photo.capturedAt)}</small>
            </div>
          </header>

          <figure className="journal-photo-post__figure">
            <CapsulePhotoImage
              source={photo.image}
              alt={title}
              className="journal-photo-post__image"
            />
          </figure>

          <div className="journal-photo-post__caption">
            <p>
              <strong>{photo.contributorName}</strong>{' '}
              {photo.caption.trim() || `A little moment from ${photo.capsuleTitle}.`}
            </p>
            <span>
              {photo.capsuleId === JOURNAL_LIBRARY_ID ? 'Added to' : 'Opened from'}{' '}
              {photo.capsuleTitle}
            </span>
          </div>
        </article>
      </div>

      <nav
        className="journal-photo-viewer__pager"
        aria-label="Journal photo feed"
      >
        <button
          type="button"
          disabled={activeIndex <= 0}
          onClick={() => openAdjacentPhoto(activeIndex - 1)}
        >
          Previous
        </button>
        <span>{activeIndex + 1} of {photos.length}</span>
        <button
          type="button"
          disabled={activeIndex >= photos.length - 1}
          onClick={() => openAdjacentPhoto(activeIndex + 1)}
        >
          Next
        </button>
      </nav>
    </section>
  )
}
