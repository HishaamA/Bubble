import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useLocation } from 'react-router-dom'
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
  { id: 'people', label: 'People' },
  { id: 'plans', label: 'Plans' },
  { id: 'flights', label: 'Flights' },
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
  const [openedAt] = useState(() => new Date())
  const effectiveNow = now ?? openedAt
  const effectiveCapsuleNow = capsuleNow ?? effectiveNow
  const returnedContext = (location.state as JournalLocationState | null)
    ?.journalContext
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
    <section className="journal-page" aria-labelledby="journal-title">
      <header className="journal-page__header">
        <h1 id="journal-title">Journal</h1>
        <p>Your family, through time and across every journey.</p>
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

      <div
        className="journal-page__panel"
        id={`journal-panel-${activeSection}`}
        role="tabpanel"
        aria-labelledby={`journal-tab-${activeSection}`}
      >
        {activeSection === 'people' ? (
          <PeopleTimeline
            photos={photos}
            journalPhotos={journalPhotos}
            cacheNamespace={capsuleCacheNamespace}
            initialPersonId={returnedPersonId}
            focusMemoryId={returnedMemoryId}
            onUploadPhotos={onUploadJournalPhotos}
            photoImportProgress={journalPhotoImportProgress}
          />
        ) : null}
        {activeSection === 'plans' ? <JournalEventsSection /> : null}
        {activeSection === 'flights' ? (
          <FlightTrackerSection now={now} />
        ) : null}
      </div>
    </section>
  )
}
