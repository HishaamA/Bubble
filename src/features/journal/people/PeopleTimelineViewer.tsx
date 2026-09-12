import type { ReactNode, Ref } from 'react'
import { Link } from 'react-router-dom'
import { TimelinePhotoImage } from './TimelinePhotoImage'
import { formatTimelinePhotoDate } from './peopleTimelineHelpers'
import type {
  FaceSuggestion,
  PeopleTimelinePhoto,
  StoredFaceDetection,
  TimelineDateOverride,
  TimelinePerson,
} from './types'

type PhotoReview = {
  match: FaceSuggestion
  face?: StoredFaceDetection
  person?: TimelinePerson
}

type PeopleTimelineViewerProps = {
  photo: PeopleTimelinePhoto
  layout: 'album' | 'scrapbook' | 'review'
  personId: string
  personName: string
  dateOverride?: TimelineDateOverride
  position: { index: number; total: number }
  review?: PhotoReview
  photoLinkRef: Ref<HTMLAnchorElement>
  photoFigureRef: Ref<HTMLElement>
  onReview: (match: FaceSuggestion, decision: 'yes' | 'no' | 'unsure') => void
  onPositionChange: (index: number) => void
  onEditDate: () => void
  children?: ReactNode
}

/** Builds the correct viewer route for direct-library and Capsule photos. */
function photoDestination(photo: PeopleTimelinePhoto) {
  if (photo.kind === 'journal-photo') {
    return `/journal/library/${encodeURIComponent(photo.id)}`
  }
  return `/journal/photo/${encodeURIComponent(photo.capsuleId)}/${encodeURIComponent(photo.id)}`
}

/** Captures enough Journal state to restore the person and photo on return. */
function photoRouteState(photo: PeopleTimelinePhoto, personId: string) {
  return {
    returnTo: '/journal',
    sourceMemoryId: photo.id,
    journalContext: {
      section: 'people',
      personId,
      focusMemoryId: photo.memoryId,
      focusPhotoKey: photo.key,
    },
  }
}

/** Renders the selected photo; its owner controls navigation and consumes widget focus. */
export function PeopleTimelineViewer({
  photo,
  layout,
  personId,
  personName,
  dateOverride,
  position,
  review,
  photoLinkRef,
  photoFigureRef,
  onReview,
  onPositionChange,
  onEditDate,
  children,
}: PeopleTimelineViewerProps) {
  const dateLabel = formatTimelinePhotoDate(photo, dateOverride)
  return (
    <div className="people-timeline__viewer" data-layout={layout}>
      {layout === 'review' ? (
        <Link
          ref={photoLinkRef}
          className="people-timeline__photo-link"
          data-face-review={review?.face ? 'true' : 'false'}
          to={photoDestination(photo)}
          state={photoRouteState(photo, personId)}
          aria-label={`Open ${photo.caption}, shared by ${photo.contributorName}`}
        >
          <TimelinePhotoImage
            key={photo.key}
            source={photo.scanSource}
            alt={photo.caption}
            width={photo.displayWidth}
            height={photo.displayHeight}
          />
          {review?.face ? (
            <span
              className="people-timeline__face-focus"
              aria-hidden="true"
              style={{
                left: `${review.face.box[0] * 100}%`,
                top: `${review.face.box[1] * 100}%`,
                width: `${review.face.box[2] * 100}%`,
                height: `${review.face.box[3] * 100}%`,
              }}
            />
          ) : null}
        </Link>
      ) : layout === 'scrapbook' ? (
        <figure
          ref={photoFigureRef}
          className="people-timeline__scrapbook-photo"
          tabIndex={-1}
          aria-label={`${photo.caption}, shared by ${photo.contributorName}`}
        >
          <span className="people-timeline__scrapbook-tape" aria-hidden="true" />
          <span className="people-timeline__scrapbook-doodle" aria-hidden="true">♡</span>
          <span className="people-timeline__scrapbook-image">
            <TimelinePhotoImage
              key={photo.key}
              source={photo.scanSource}
              alt={photo.caption}
              width={photo.displayWidth}
              height={photo.displayHeight}
            />
          </span>
          <figcaption>
            <strong>{photo.caption}</strong>
            <span>{dateLabel}</span>
          </figcaption>
        </figure>
      ) : (
        <figure
          ref={photoFigureRef}
          className="people-timeline__album-photo"
          tabIndex={-1}
          aria-label={`${photo.caption}, shared by ${photo.contributorName}`}
        >
          <TimelinePhotoImage
            key={photo.key}
            source={photo.scanSource}
            alt={photo.caption}
            width={photo.displayWidth}
            height={photo.displayHeight}
          />
        </figure>
      )}

      {review?.person ? (
        <section className="people-timeline__face-review" aria-live="polite">
          <div>
            <span>Quick review</span>
            <strong>Is the outlined face {review.person.name}?</strong>
            <small>Your answer improves future matches only on this device.</small>
          </div>
          <div className="people-timeline__face-review-actions">
            <button type="button" onClick={() => onReview(review.match, 'yes')}>Yes</button>
            <button type="button" onClick={() => onReview(review.match, 'no')}>No</button>
            <button type="button" onClick={() => onReview(review.match, 'unsure')}>Not sure</button>
          </div>
        </section>
      ) : null}

      <div className="people-timeline__timeline-meta" aria-live="polite">
        <div>
          <time dateTime={dateOverride?.value ?? photo.capturedAt}>{dateLabel}</time>
          <span>{position.index + 1} of {position.total}</span>
        </div>
        <button type="button" onClick={onEditDate}>Edit date</button>
      </div>

      <label className="people-timeline__scrubber">
        <span className="people-timeline__sr-only">Timeline position for {personName}</span>
        <input
          type="range"
          min="0"
          max={Math.max(0, position.total - 1)}
          step="1"
          value={position.index}
          disabled={position.total < 2}
          aria-valuetext={`${position.index + 1} of ${position.total}, ${dateLabel}`}
          onChange={(event) => onPositionChange(Number(event.target.value))}
        />
        <span className="people-timeline__scrubber-ends" aria-hidden="true">
          <span>Oldest</span><span>Latest</span>
        </span>
      </label>
      {children}
    </div>
  )
}
