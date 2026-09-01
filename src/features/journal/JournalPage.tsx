import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { AppWhimsy } from '../../app/AppWhimsy'
import type { FamilyCapsule } from '../capsules/types'
import { JournalEventsSection } from '../events'
import { FlightTrackerSection } from '../flights'
import { unlockedCapsulePhotos } from './capsuleJournalArchive'
import type {
  JournalPhoto,
  JournalPhotoImportProgress,
  JournalPhotoImportResult,
} from './journalPhotoTypes'
import { PeopleTimeline } from './people'
import './JournalPage.css'

const journalSections = [
  {
    id: 'people',
    label: 'Photos',
    subtitle: 'Your private place to remember.',
  },
  {
    id: 'plans',
    label: 'Plans',
    subtitle: 'Plans made together.',
  },
  {
    id: 'flights',
    label: 'Flights',
    subtitle: 'Journeys worth remembering.',
  },
] as const

type JournalSection = (typeof journalSections)[number]['id']

type JournalLocationState = {
  journalContext?: {
    section?: unknown
    personId?: unknown
    focusMemoryId?: unknown
  }
}

type JournalPageProps = {
  now?: Date
  capsules?: FamilyCapsule[]
  capsuleNow?: Date
  capsuleCacheNamespace?: string
  journalPhotos?: readonly JournalPhoto[]
  onUploadJournalPhotos?: (
    files: readonly File[],
  ) => Promise<JournalPhotoImportResult>
  journalPhotoImportProgress?: JournalPhotoImportProgress
  openAllPhotosByDefault?: boolean
}

function readJournalSection(value: unknown): JournalSection | null {
  return journalSections.some(({ id }) => id === value)
    ? value as JournalSection
    : null
}

export function JournalPage({
  now,
  capsules = [],
  capsuleNow,
  capsuleCacheNamespace = 'signed-out:no-family',
  journalPhotos = [],
  onUploadJournalPhotos,
  journalPhotoImportProgress,
}: JournalPageProps = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { personId: routePersonId } = useParams<{ personId?: string }>()
  const personScrapbookOpen = Boolean(routePersonId)
  const [openedAt] = useState(() => new Date())
  const effectiveNow = now ?? openedAt
  const effectiveCapsuleNow = capsuleNow ?? effectiveNow
  const returnedContext = (location.state as JournalLocationState | null)
    ?.journalContext
  // Photo and panorama routes return through navigation state. Read it once as
  // the initial tab/person context so ordinary tab changes remain user-owned.
  const returnedSection = readJournalSection(
    returnedContext?.section,
  )
  const returnedPersonId = typeof returnedContext?.personId === 'string'
    ? returnedContext.personId
    : undefined
  const returnedMemoryId = typeof returnedContext?.focusMemoryId === 'string'
    ? returnedContext.focusMemoryId
    : undefined
  const [activeSection, setActiveSection] = useState<JournalSection>(
    () => returnedSection ?? 'people',
  )
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const photos = useMemo(
    // Locked capsule media never reaches PeopleTimeline, its face scanner, or
    // the DOM. Unlocking is a data boundary, not just a visual overlay.
    () => unlockedCapsulePhotos(capsules, effectiveCapsuleNow),
    [capsules, effectiveCapsuleNow],
  )

  function chooseSection(section: JournalSection, focus = false) {
    setActiveSection(section)
    if (focus) {
      const index = journalSections.findIndex(({ id }) => id === section)
      tabRefs.current[index]?.focus()
    }
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    // This is a manual-activation tablist: arrow keys move and activate in one
    // step, matching the compact three-tab control on mobile.
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % journalSections.length
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + journalSections.length) % journalSections.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = journalSections.length - 1
    }

    if (nextIndex === null) return
    event.preventDefault()
    chooseSection(journalSections[nextIndex].id, true)
  }

  return (
    <section
      className={`journal-page${personScrapbookOpen ? ' journal-page--person-scrapbook' : ''}`}
      data-section={personScrapbookOpen ? 'people' : activeSection}
      aria-labelledby={personScrapbookOpen ? undefined : 'journal-title'}
    >
      {!personScrapbookOpen ? <AppWhimsy page="journal" /> : null}
      {!personScrapbookOpen ? <div className="journal-page__chrome">
        <header className="journal-page__header app-page-header">
          <div>
            <p className="journal-page__eyebrow app-page-header__eyebrow">Our family</p>
            <h1 id="journal-title">Journal</h1>
            <p className="journal-page__subtitle app-page-header__subtitle">
              {journalSections.find(({ id }) => id === activeSection)?.subtitle}
            </p>
          </div>
          <svg
            className="journal-page__doodles"
            viewBox="0 0 132 74"
            aria-hidden="true"
          >
            <g className="journal-page__doodle-cloud">
              <path d="M8 33c1-7 7-11 14-10 3-8 15-10 21-3 8-3 16 3 16 11 5 0 8 3 9 7H8c-4-1-4-5 0-5Z" />
            </g>
            <g className="journal-page__doodle-sun">
              <circle cx="96" cy="24" r="10" />
              <path d="M96 5v6m0 26v6M77 24h7m25 0h7M82 10l5 5m18 18 5 5m0-28-5 5M87 33l-5 5" />
            </g>
            <g className="journal-page__doodle-leaf">
              <path d="M91 69c9-12 17-18 28-23M102 57c-4-8 0-12 8-12 0 7-2 11-8 12Zm8-6c2-8 7-10 13-6-3 7-7 9-13 6Zm-15 13c-5-6-3-11 4-13 2 6 1 10-4 13Z" />
            </g>
          </svg>
        </header>

        <div
          className="journal-page__tabs"
          role="tablist"
          aria-label="Journal sections"
        >
          {journalSections.map((section, index) => {
            const selected = activeSection === section.id
            return (
              <button
                key={section.id}
                ref={(node) => {
                  tabRefs.current[index] = node
                }}
                id={`journal-tab-${section.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`journal-panel-${section.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => chooseSection(section.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {section.label}
              </button>
            )
          })}
        </div>
      </div> : null}

      <div
        className="journal-page__panel"
        id={`journal-panel-${personScrapbookOpen ? 'people' : activeSection}`}
        role={personScrapbookOpen ? undefined : 'tabpanel'}
        aria-labelledby={personScrapbookOpen ? undefined : `journal-tab-${activeSection}`}
      >
        {personScrapbookOpen || activeSection === 'people' ? (
          <PeopleTimeline
            photos={photos}
            journalPhotos={journalPhotos}
            cacheNamespace={capsuleCacheNamespace}
            initialPersonId={routePersonId ?? returnedPersonId}
            focusMemoryId={returnedMemoryId}
            onUploadPhotos={onUploadJournalPhotos}
            photoImportProgress={journalPhotoImportProgress}
            personAlbumOpen={personScrapbookOpen}
            onOpenPersonAlbum={(personId) => navigate(
              `/journal/person/${encodeURIComponent(personId)}`,
            )}
            onClosePersonAlbum={() => navigate('/journal', {
              replace: true,
              state: { journalContext: { section: 'people' } },
            })}
          />
        ) : null}
        {!personScrapbookOpen && activeSection === 'plans' ? <JournalEventsSection /> : null}
        {!personScrapbookOpen && activeSection === 'flights' ? (
          <FlightTrackerSection now={now} />
        ) : null}
      </div>
    </section>
  )
}
