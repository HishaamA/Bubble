import type { MouseEventHandler } from 'react'
import { TimelinePhotoImage } from './TimelinePhotoImage'
import type { PeoplePhotoAlbum } from './peopleTimelineSelectors'
import type { PeopleTimelinePhoto, TimelinePerson } from './types'

type PeopleTimelinePeopleProps = {
  people: readonly TimelinePerson[]
  previews: ReadonlyMap<string, PeopleTimelinePhoto>
  enrolledPersonIds: ReadonlySet<string>
  selectedPersonId: string
  setupComplete: boolean
  addDisabled: boolean
  onOpenAlbum: (personId: string) => void
  onManagePerson: (person: TimelinePerson) => void
  onAddPerson: MouseEventHandler<HTMLButtonElement>
}

function personInitials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? '').join('') || '?'
}

/** Controlled people rail; enrollment and navigation remain owned by the timeline. */
export function PeopleTimelinePeople({
  people,
  previews,
  enrolledPersonIds,
  selectedPersonId,
  setupComplete,
  addDisabled,
  onOpenAlbum,
  onManagePerson,
  onAddPerson,
}: PeopleTimelinePeopleProps) {
  const emptySlotCount = Math.max(1, 3 - people.length)
  return (
    <section
      className="people-timeline__setup"
      aria-label={setupComplete ? 'Family people' : undefined}
      aria-labelledby={setupComplete ? undefined : 'people-setup-title'}
    >
      <div className="people-timeline__setup-slots" role="group" aria-label="Family face setup">
        {people.map((person) => {
          const preview = previews.get(person.id)
          const ready = enrolledPersonIds.has(person.id)
          const hasAlbum = Boolean(preview)
          return (
            <button
              key={person.id}
              type="button"
              className="people-timeline__setup-person"
              data-ready={ready ? 'true' : 'false'}
              data-needs-face={ready ? 'false' : 'true'}
              aria-label={ready || hasAlbum ? person.name : `${person.name}, face photo needed`}
              aria-pressed={selectedPersonId === person.id}
              onClick={() => ready || hasAlbum ? onOpenAlbum(person.id) : onManagePerson(person)}
            >
              <span className="people-timeline__setup-circle">
                {preview ? <TimelinePhotoImage source={preview.source} alt="" /> : (
                  <span className="people-timeline__initials" aria-hidden="true">
                    {personInitials(person.name)}
                  </span>
                )}
              </span>
              <strong>{person.name}</strong>
            </button>
          )
        })}
        {Array.from({ length: emptySlotCount }, (_, slotIndex) => {
          const slotIsAvailable = slotIndex === 0
          return (
            <button
              key={`setup-slot-${slotIndex}`}
              type="button"
              className={`people-timeline__setup-person people-timeline__setup-person--empty ${
                slotIsAvailable
                  ? 'people-timeline__setup-person--add'
                  : 'people-timeline__setup-person--placeholder'
              }`}
              aria-label={slotIsAvailable ? 'Add person' : `Empty family slot ${slotIndex}`}
              disabled={!slotIsAvailable || addDisabled}
              onClick={onAddPerson}
            >
              <span className="people-timeline__setup-circle" aria-hidden="true">
                {slotIsAvailable ? '＋' : ''}
              </span>
              {slotIsAvailable ? <strong>Add person</strong> : null}
            </button>
          )
        })}
      </div>
      {!setupComplete ? (
        <div className="people-timeline__setup-copy">
          <h3 id="people-setup-title">Create your people</h3>
          <p>Add two family members to start grouping the photos they share.</p>
        </div>
      ) : null}
    </section>
  )
}

type PeopleTimelineAlbumsProps = {
  albums: readonly PeoplePhotoAlbum[]
  expanded: boolean
  id: string
  hasPeople: boolean
  onExpand: () => void
  onOpenAlbum: (personId: string) => void
  onShowAllPhotos: () => void
  onAddPerson: MouseEventHandler<HTMLButtonElement>
}

/** Album tiles share the rail's indexed covers without holding selection state. */
export function PeopleTimelineAlbums({
  albums, expanded, id, hasPeople, onExpand, onOpenAlbum, onShowAllPhotos, onAddPerson,
}: PeopleTimelineAlbumsProps) {
  const displayedAlbums = expanded ? albums : albums.slice(0, 2)
  return (
    <section className="people-timeline__albums" aria-labelledby="people-albums-title">
      <header className="people-timeline__albums-header">
        <div>
          <h3 id="people-albums-title">Face-matched albums</h3>
          <p><span aria-hidden="true">♙</span>On-device · private</p>
        </div>
        {albums.length > displayedAlbums.length ? (
          <button type="button" aria-controls={id} aria-expanded={expanded} onClick={onExpand}>
            See all <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </header>
      {albums.length ? (
        <div id={id} className="people-timeline__album-grid">
          {displayedAlbums.map(({ person, preview, photoCount }, index) => (
            <button
              key={person.id}
              type="button"
              className="people-timeline__album-tile"
              data-tint={index % 3}
              aria-label={`Open ${person.name}'s scrapbook, ${photoCount} matched ${photoCount === 1 ? 'photo' : 'photos'}`}
              onClick={() => onOpenAlbum(person.id)}
            >
              <span className="people-timeline__album-tile-image">
                <TimelinePhotoImage source={preview.source} alt="" width={preview.displayWidth} height={preview.displayHeight} />
              </span>
              <span className="people-timeline__album-tile-copy">
                <strong>{person.name}</strong>
                <small>{photoCount} matched {photoCount === 1 ? 'photo' : 'photos'}</small>
              </span>
              <span className="people-timeline__album-tile-doodle" aria-hidden="true">
                {index % 3 === 0 ? '✦' : index % 3 === 1 ? '⌁' : '♡'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="people-timeline__albums-empty"
          onClick={hasPeople ? onShowAllPhotos : onAddPerson}
        >
          <span className="people-timeline__albums-empty-icon" aria-hidden="true">✦</span>
          <span className="people-timeline__albums-empty-copy">
            <strong>Your first scrapbook starts here</strong>
            <small>{hasPeople ? 'Matched family photos will collect here.' : 'Add a person to begin matching photos.'}</small>
          </span>
          <span className="people-timeline__albums-empty-arrow" aria-hidden="true">›</span>
        </button>
      )}
    </section>
  )
}
