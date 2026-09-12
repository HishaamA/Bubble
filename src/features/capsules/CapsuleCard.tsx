import type { ChangeEvent, ReactNode } from 'react'
import { formatCapsuleCountdown, isCapsuleUnlocked } from './capsuleDates'
import { CapsulePhotoImage } from './CapsulePhotoImage'
import { CapsuleContributorBadge } from './CapsuleContributorBadge'
import { capsuleDisplayTitle, capsuleRecapPhotos, mayPreviewCapsulePhotos } from './capsuleViewModel'
import type { CapsulePhoto, FamilyCapsule } from './types'

type CapsuleCardProps = {
  capsule: FamilyCapsule
  now: Date
  uploading: boolean
  demoUnlocked: boolean
  allowLockedPreview: boolean
  hideHeader?: boolean
  removalAction?: ReactNode
  managementActions?: ReactNode
  onChoosePhoto: (event: ChangeEvent<HTMLInputElement>, capsule: FamilyCapsule) => void
  onOpenRecap: (capsule: FamilyCapsule) => void
  onDemoUnlock: (capsule: FamilyCapsule) => void
}

/** Formats compact reveal-day copy for Capsule cards. */
function formatOpenDate(capsule: FamilyCapsule) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(capsule.opensAt))
}

/** Formats the full reveal instant used by accessible lock descriptions. */
function formatExactOpenDate(opensAt: string) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(opensAt))
}

/** Produces grammatically correct photo-count copy. */
function photoCountLabel(count: number) {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`
}

/** Supplies one consistent lock glyph to visual and accessible Capsule states. */
export function CapsuleLockIcon() {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path d="M8.25 12.25V9.7a5.75 5.75 0 0 1 11.5 0v2.55" />
      <rect x="5.75" y="12.25" width="16.5" height="12" rx="5" />
      <path d="M14 17.1v3.1" />
    </svg>
  )
}

/** Hides locked media behind a reveal-time description without mounting the image. */
function CapsuleLockedCover({ opensAt }: { opensAt: string }) {
  return (
    <div
      className="capsule-locked-cover"
      role="img"
      aria-label={`Locked until ${formatExactOpenDate(opensAt)}`}
    >
      <span className="capsule-locked-cover__icon"><CapsuleLockIcon /></span>
      <span className="capsule-locked-cover__message" aria-hidden="true">Still gathering…</span>
      <span className="capsule-visually-hidden">This Capsule unlocks</span>
      <time className="capsule-visually-hidden" dateTime={opensAt}>{formatExactOpenDate(opensAt)}</time>
    </div>
  )
}

const LOCKED_CAPSULE_TEASER_SRC = '/assets/capsules/demo-locked-capsule-photos.png'

/** Decorative blurred frames only: never counted, saved, or included in a recap. */
function LockedCapsuleTeasers() {
  return (
    <ul className="capsule-empty-polaroids capsule-empty-polaroids--teasers" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        <li key={index}>
          <span className="capsule-empty-polaroids__image">
            <img
              src={LOCKED_CAPSULE_TEASER_SRC}
              alt=""
              draggable="false"
            />
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Shares a restrained paper back and pocket across gathering and past
 * keepsakes. Decorative frames can peek out without becoming recap content.
 */
function CapsuleEnvelopeLayers() {
  return (
    <>
      <span className="capsule-envelope__back" aria-hidden="true" />
      <span className="capsule-envelope__front" aria-hidden="true">
        <span className="capsule-envelope__stitch" />
      </span>
    </>
  )
}

/** A past keepsake stays closed until deliberately opened, without loading thumbnails. */
function CapsuleKeepsakeCover({
  title,
  available,
  onOpen,
}: {
  title: string
  available: boolean
  onOpen: () => void
}) {
  return (
    <div className="capsule-collection__photos capsule-envelope capsule-envelope--keepsake" data-locked="false">
      <CapsuleEnvelopeLayers />
      <button
        type="button"
        className="capsule-envelope__open"
        aria-label={`Open ${title} recap`}
        disabled={!available}
        onClick={onOpen}
      >
        <span className="capsule-envelope__seal" aria-hidden="true">♡</span>
        <span>{available ? 'Open memories' : 'Photos unavailable'}</span>
      </button>
    </div>
  )
}

/** Selects empty, sealed, or visible photo-strip states without crossing the lock boundary. */
function PhotoStrip({
  photos,
  totalPhotoCount,
  locked,
  opensAt,
}: {
  photos: CapsulePhoto[]
  totalPhotoCount: number
  locked: boolean
  opensAt: string
}) {
  const representedPhotoCount = Math.max(photos.length, totalPhotoCount)

  // A sealed envelope uses decorative, blurred scenes, never private bytes.
  // Weekly and special Capsules share this same compact preview boundary.
  if (locked) {
    const photoState = representedPhotoCount === 0
      ? 'empty'
      : representedPhotoCount === 1
        ? 'single'
        : 'multiple'

    return (
      <div
        className="capsule-collection__photos capsule-envelope"
        data-locked="true"
        data-photo-state={photoState}
      >
        <CapsuleEnvelopeLayers />
        <LockedCapsuleTeasers />
        <CapsuleLockedCover opensAt={opensAt} />
      </div>
    )
  }

  if (representedPhotoCount === 0) {
    return (
      <div className="capsule-collection__photos" data-empty="true" data-locked="false">
        <ul className="capsule-empty-polaroids" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <li key={index}><span>{index % 2 === 0 ? '✦' : '♡'}</span></li>
          ))}
        </ul>
        <div className="capsule-photo-strip capsule-photo-strip--empty">
          <p>The first little moment can be yours.</p>
        </div>
      </div>
    )
  }

  const hasMorePhotos = representedPhotoCount > 4
  const mediaSlotCount = hasMorePhotos ? 3 : 4
  const visiblePhotos = photos.slice(0, mediaSlotCount)
  const concealedSlotCount = Math.max(
    0,
    Math.min(mediaSlotCount, representedPhotoCount) - visiblePhotos.length,
  )

  return (
    <div className="capsule-collection__photos" data-locked="false">
      <ul
        className="capsule-photo-strip"
        aria-label={`${photoCountLabel(representedPhotoCount)} in this Capsule`}
      >
        {visiblePhotos.map((photo) => (
          <li key={photo.id}>
            <CapsulePhotoImage
              source={photo.thumbnail}
              alt={`${photo.caption || 'Capsule photo'} from ${photo.contributorName}`}
            />
            <CapsuleContributorBadge name={photo.contributorName} avatarUrl={photo.contributorAvatarUrl} />
          </li>
        ))}
        {Array.from({ length: concealedSlotCount }, (_, index) => (
          <li
            className="capsule-photo-strip__concealed"
            key={`concealed-${index}`}
            aria-hidden="true"
          />
        ))}
        {hasMorePhotos ? (
          <li className="capsule-photo-strip__more">+{representedPhotoCount - mediaSlotCount}</li>
        ) : null}
      </ul>
    </div>
  )
}

/** Presents one Capsule's state and exposes only actions valid before or after reveal. */
export function CapsuleCard({
  capsule,
  now,
  uploading,
  demoUnlocked,
  allowLockedPreview,
  hideHeader = false,
  removalAction,
  managementActions,
  onChoosePhoto,
  onOpenRecap,
  onDemoUnlock,
}: CapsuleCardProps) {
  const unlocked = isCapsuleUnlocked(capsule.opensAt, now)
  const canContribute = !unlocked
  const totalPhotoCount = capsule.totalPhotoCount ?? capsule.photos.length
  const pendingPhotoCount = capsule.photos.filter(({ syncStatus }) => syncStatus === 'pending').length
  const recapPhotoCount = capsuleRecapPhotos(capsule.photos).length
  const displayTitle = capsuleDisplayTitle(capsule)
  const showPhotos = demoUnlocked || mayPreviewCapsulePhotos(capsule, now)
  const showKeepsake = unlocked && !showPhotos

  return (
    <article
      id={`capsule-${capsule.id}`}
      className="capsule-collection"
      data-kind={capsule.kind}
      data-featured={hideHeader ? 'true' : undefined}
      data-demo-unlocked={demoUnlocked ? 'true' : 'false'}
      data-has-removal={removalAction ? 'true' : undefined}
      data-preview={showKeepsake ? 'keepsake' : showPhotos ? 'photos' : 'locked'}
    >
      {removalAction ? <div className="capsule-collection__removal">{removalAction}</div> : null}
      <header className="capsule-collection__header" aria-hidden={hideHeader ? 'true' : undefined}>
        <div>
          {capsule.kind === 'special' ? <p>Special Capsule</p> : null}
          <h2>{displayTitle}</h2>
        </div>
        <span className="capsule-collection__state" data-unlocked={unlocked ? 'true' : 'false'}>
          {unlocked ? 'Open' : formatCapsuleCountdown(capsule.opensAt, now)}
        </span>
      </header>

      {showKeepsake ? (
        <CapsuleKeepsakeCover
          title={displayTitle}
          available={recapPhotoCount > 0}
          onOpen={() => onOpenRecap(capsule)}
        />
      ) : (
        <PhotoStrip
          photos={capsule.photos}
          totalPhotoCount={totalPhotoCount}
          locked={!unlocked && !demoUnlocked}
          opensAt={capsule.opensAt}
        />
      )}

      <div className="capsule-collection__details">
        <p>
          <strong>{photoCountLabel(totalPhotoCount)}</strong>
          <span>
            {pendingPhotoCount > 0
              ? unlocked
                ? `${photoCountLabel(pendingPhotoCount)} saved on this phone`
                : `${photoCountLabel(pendingPhotoCount)} waiting to share`
              : unlocked
                ? 'ready for your family recap'
                : `opens ${formatOpenDate(capsule)}`}
          </span>
        </p>
        {canContribute ? (
          <label className="capsule-add-photo">
            <input
              type="file"
              accept="image/*"
              disabled={uploading}
              onChange={(event) => onChoosePhoto(event, capsule)}
            />
            <span aria-hidden="true">+</span>
            {uploading ? 'Adding…' : 'Add photo'}
          </label>
        ) : (
          <button
            className="capsule-open-recap"
            type="button"
            disabled={recapPhotoCount === 0}
            onClick={() => onOpenRecap(capsule)}
          >
            {recapPhotoCount > 0 ? 'Play recap' : 'Photos unavailable on this phone'}
          </button>
        )}
      </div>
      {allowLockedPreview && !unlocked && capsule.photos.length > 0 ? (
        <button
          className="capsule-demo-unlock"
          type="button"
          aria-label={`Demo only: Preview ${displayTitle} recap`}
          onClick={() => onDemoUnlock(capsule)}
        >
          <span>Demo only</span>
          Preview this Capsule recap
        </button>
      ) : null}
      {managementActions ? (
        <footer className="capsule-collection__management">{managementActions}</footer>
      ) : null}
    </article>
  )
}
