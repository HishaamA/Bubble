import { useId, useState, type CSSProperties } from 'react'
import { TimelinePhotoImage } from './TimelinePhotoImage'
import { formatTimelinePhotoDate } from './peopleTimelineHelpers'
import {
  loadPersonScrapbookProfile,
  savePersonScrapbookProfile,
  type PersonScrapbookProfile,
} from './personScrapbookStore'
import type {
  PeopleTimelinePhoto,
  TimelineDateOverride,
  TimelinePerson,
} from './types'
import './PersonScrapbookPage.css'

export type PersonScrapbookPageProps = {
  person: TimelinePerson
  photos: readonly PeopleTimelinePhoto[]
  cacheNamespace: string
  dateOverrides?: Record<string, TimelineDateOverride>
  onBack?: () => void
  onManage?: () => void
}

type ScrapbookCardStyle = CSSProperties & {
  '--scrapbook-card-color': string
  '--scrapbook-tape-color': string
  '--scrapbook-tilt': string
  '--scrapbook-delay': string
}

const CARD_COLORS = [
  '#fffaf0',
  '#f6e2d4',
  '#e6efdf',
  '#dcecf3',
  '#e9e0f2',
] as const
const TAPE_COLORS = [
  'rgba(239, 185, 68, 0.7)',
  'rgba(169, 148, 194, 0.66)',
  'rgba(145, 173, 131, 0.68)',
  'rgba(230, 111, 85, 0.64)',
  'rgba(120, 184, 208, 0.68)',
] as const
const CARD_TILTS = ['-1.8deg', '1.25deg', '-0.65deg', '1.7deg', '-1.15deg'] as const
const CARD_DOODLES = ['✦', '♡', '≈', '❋', '⌁'] as const

function photoDescription(photo: PeopleTimelinePhoto, personName: string) {
  return photo.caption.trim() || `A family photo with ${personName}`
}

function PersonScrapbookContent({
  person,
  photos,
  cacheNamespace,
  dateOverrides,
  onBack,
  onManage,
}: PersonScrapbookPageProps) {
  const titleId = useId()
  const collageTitleId = useId()
  const [profile, setProfile] = useState<PersonScrapbookProfile>(() =>
    loadPersonScrapbookProfile(cacheNamespace, person.id),
  )
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')
  const photoCountLabel = `${photos.length} ${photos.length === 1 ? 'little moment' : 'little moments'}`

  function updateProfile<Key extends keyof PersonScrapbookProfile>(
    field: Key,
    value: PersonScrapbookProfile[Key],
  ) {
    const nextProfile = { ...profile, [field]: value }
    setProfile(nextProfile)
    setSaveState(
      savePersonScrapbookProfile(cacheNamespace, person.id, nextProfile)
        ? 'saved'
        : 'error',
    )
  }

  return (
    <section className="person-scrapbook" aria-labelledby={titleId}>
      <header className="person-scrapbook__header">
        {onBack || onManage ? (
          <div className="person-scrapbook__actions">
            {onBack ? (
              <button type="button" onClick={onBack} aria-label="Back to people">
                <span aria-hidden="true">←</span>
                Back
              </button>
            ) : <span />}
            {onManage ? (
              <button
                type="button"
                className="person-scrapbook__manage"
                onClick={onManage}
                aria-label={`Manage ${person.name}`}
              >
                Manage
                <span aria-hidden="true">✎</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="person-scrapbook__heading">
          <p>Our family scrapbook</p>
          <h1 id={titleId}>{person.name}</h1>
          <span>{photoCountLabel}, gathered together.</span>
        </div>

        <svg
          className="person-scrapbook__header-doodle"
          viewBox="0 0 112 72"
          aria-hidden="true"
          focusable="false"
        >
          <path className="person-scrapbook__doodle-sun" d="M82 18a8 8 0 1 0 16 0 8 8 0 0 0-16 0ZM90 2v6M90 28v6M74 18h6M100 18h6M79 7l4 4M97 25l4 4M101 7l-4 4M83 25l-4 4" />
          <path className="person-scrapbook__doodle-line" d="M4 58c17-15 30 10 47-5s27-8 44 3" />
          <path className="person-scrapbook__doodle-heart" d="M19 21c-6-7-15 2 0 14 15-12 6-21 0-14Z" />
        </svg>
      </header>

      <section className="person-scrapbook__moments" aria-labelledby={collageTitleId}>
        <div className="person-scrapbook__moments-heading">
          <div>
            <p>Through the years</p>
            <h2 id={collageTitleId}>{person.name}’s little moments</h2>
          </div>
          <span aria-hidden="true">♥</span>
        </div>

        {photos.length ? (
          <div className="person-scrapbook__collage">
            {photos.map((photo, index) => {
              const cardStyle = {
                '--scrapbook-card-color': CARD_COLORS[index % CARD_COLORS.length],
                '--scrapbook-tape-color': TAPE_COLORS[index % TAPE_COLORS.length],
                '--scrapbook-tilt': CARD_TILTS[index % CARD_TILTS.length],
                '--scrapbook-delay': `${Math.min(index, 8) * 38}ms`,
              } as ScrapbookCardStyle
              const description = photoDescription(photo, person.name)
              return (
                <figure
                  key={photo.key}
                  className="person-scrapbook__photo"
                  style={cardStyle}
                >
                  <span className="person-scrapbook__tape" aria-hidden="true" />
                  <span className="person-scrapbook__photo-image">
                    <TimelinePhotoImage
                      source={photo.scanSource}
                      alt={description}
                      width={photo.displayWidth}
                      height={photo.displayHeight}
                      lazy
                    />
                  </span>
                  <figcaption>
                    <strong>{description}</strong>
                    <span>
                      <time dateTime={dateOverrides?.[photo.key]?.value ?? photo.capturedAt}>
                        {formatTimelinePhotoDate(
                          photo,
                          dateOverrides?.[photo.key],
                        )}
                      </time>
                      {photo.contributorName ? ` · ${photo.contributorName}` : ''}
                    </span>
                  </figcaption>
                  <span className="person-scrapbook__photo-doodle" aria-hidden="true">
                    {CARD_DOODLES[index % CARD_DOODLES.length]}
                  </span>
                </figure>
              )
            })}
          </div>
        ) : (
          <div className="person-scrapbook__empty" role="status">
            <span aria-hidden="true">♡</span>
            <h3>A page waiting for memories</h3>
            <p>Photos matched with {person.name} will gather here.</p>
          </div>
        )}
      </section>

      <form
        className="person-scrapbook__details"
        aria-label={`Details about ${person.name}`}
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="person-scrapbook__details-heading">
          <div>
            <span>Little details</span>
            <h2>The things we know by heart</h2>
          </div>
          <p>Saved privately on this device.</p>
        </div>

        <div className="person-scrapbook__details-grid">
          <label>
            <span>Birthday</span>
            <input
              type="date"
              value={profile.birthday}
              onChange={(event) => updateProfile('birthday', event.target.value)}
            />
          </label>
          <label>
            <span>Relation</span>
            <input
              type="text"
              maxLength={60}
              value={profile.relation}
              placeholder="Cousin, grandad, friend…"
              onChange={(event) => updateProfile('relation', event.target.value)}
            />
          </label>
          <label>
            <span>Favorite things</span>
            <textarea
              rows={2}
              maxLength={240}
              value={profile.favoriteThings}
              placeholder="Mango cake, garden mornings, old songs…"
              onChange={(event) =>
                updateProfile('favoriteThings', event.target.value)}
            />
          </label>
          <label>
            <span>Notes</span>
            <textarea
              rows={3}
              maxLength={1_200}
              value={profile.notes}
              placeholder={`Write down the small things you never want to forget about ${person.name}.`}
              onChange={(event) => updateProfile('notes', event.target.value)}
            />
          </label>
        </div>

        <p
          className="person-scrapbook__save-status"
          data-state={saveState}
          role={saveState === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {saveState === 'saved'
            ? 'Saved on this device.'
            : saveState === 'error'
              ? 'These details could not be saved on this device.'
              : 'Changes save as you write.'}
        </p>
      </form>
    </section>
  )
}

export function PersonScrapbookPage(props: PersonScrapbookPageProps) {
  const scrapbookIdentity = `${props.cacheNamespace}\u0000${props.person.id}`
  return <PersonScrapbookContent key={scrapbookIdentity} {...props} />
}
