import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  addLocalDays,
  formatLocalDay,
  isAfterLocalDay,
  startOfLocalDay,
  toLocalIsoDate,
} from '../../lib/appDate'
import type {
  CapsuleImageSource,
  FamilyCapsule,
} from '../capsules/types'
import { JournalEventsSection } from '../events'
import type { PanoramaMoment } from '../memories/shared'
import { CapsulePhotoImage } from './CapsulePhotoImage'
import { unlockedCapsulePhotos } from './capsuleJournalArchive'
import './JournalPage.css'

type JournalDay = {
  key: string
  shortDay: string
  date: string
  dateValue: Date
  isoDate: string
  fullDate: string
  memoryIds: string[]
}

type JournalMemoryImage =
  | {
      kind: 'photo'
      src: CapsuleImageSource
    }
  | {
      kind: 'contactSheet'
      src: string
      column: 0 | 1 | 2
      row: 0 | 1 | 2
    }
  | {
      kind: 'placeholder'
    }

type JournalMemoryBase = {
  id: string
  title: string
  author: string
  archivedAt?: string
  image: JournalMemoryImage
}

type JournalMemory = JournalMemoryBase & (
  | {
      kind: 'panorama'
      memoryId: string
    }
  | {
      kind: 'capsule-photo'
      capsuleId: string
      photoId: string
    }
)

const familyMemoryGridSrc = '/assets/journal/family-memory-grid-v1.png'

type JournalReturnContext = {
  selectedDayKey: string
  view: 'grid'
  scrollTop: number
  weekOffset?: number
  focusMemoryId?: string
}

type JournalLocationState = {
  journalContext?: Partial<JournalReturnContext>
}

const journalMemories: JournalMemory[] = [
  {
    id: 'golden-hour',
    kind: 'panorama',
    memoryId: 'mountains',
    title: 'Mountain day at golden hour',
    author: 'Hishaam',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 0,
      row: 0,
    },
  },
  {
    id: 'record-night',
    kind: 'panorama',
    memoryId: 'dinner',
    title: 'Dinner that lasted all evening',
    author: 'Mum',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 1,
      row: 0,
    },
  },
  {
    id: 'park-picnic',
    kind: 'panorama',
    memoryId: 'beach',
    title: 'Just us and the sea',
    author: 'Hishaam',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 2,
      row: 0,
    },
  },
  {
    id: 'breakfast',
    kind: 'panorama',
    memoryId: 'birthday',
    title: 'One wish, surrounded by family',
    author: 'Maya',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 0,
      row: 1,
    },
  },
  {
    id: 'city-sky',
    kind: 'panorama',
    memoryId: 'wedding',
    title: 'Leena and Omar, finally',
    author: 'Mum',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 1,
      row: 1,
    },
  },
  {
    id: 'flowers',
    kind: 'panorama',
    memoryId: 'graduation',
    title: 'Sara did it',
    author: 'Sara',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 2,
      row: 1,
    },
  },
  {
    id: 'sleepy-dog',
    kind: 'panorama',
    memoryId: 'grandparents',
    title: 'Grandad’s best laugh',
    author: 'Simreen',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 0,
      row: 2,
    },
  },
  {
    id: 'quiet-desk',
    kind: 'panorama',
    memoryId: 'cousins',
    title: 'Cousins causing trouble',
    author: 'Maya',
    image: {
      kind: 'contactSheet',
      src: familyMemoryGridSrc,
      column: 1,
      row: 2,
    },
  },
]

const demoMemoryIdsByOffset = new Map<number, string[]>([
  [-3, ['park-picnic', 'flowers', 'sleepy-dog']],
  [-2, ['record-night', 'breakfast', 'quiet-desk', 'golden-hour']],
  [-1, ['city-sky', 'flowers', 'park-picnic', 'breakfast', 'sleepy-dog']],
  [0, journalMemories.map(({ id }) => id)],
])

function sharedJournalMemoryId(momentId: string) {
  return `shared-${momentId}`
}

function toSharedJournalMemory(moment: PanoramaMoment): JournalMemory {
  return {
    id: sharedJournalMemoryId(moment.id),
    kind: 'panorama',
    memoryId: sharedJournalMemoryId(moment.id),
    title: moment.label,
    author: moment.uploaderDisplayName,
    archivedAt: moment.createdAt,
    image: moment.objectUrl
      ? { kind: 'photo', src: moment.objectUrl }
      : { kind: 'placeholder' },
  }
}

function toCapsuleJournalMemories(
  capsules: FamilyCapsule[],
  now: Date,
): JournalMemory[] {
  return unlockedCapsulePhotos(capsules, now).map((photo) => ({
    id: `capsule-${photo.capsuleId}-${photo.id}`,
    kind: 'capsule-photo',
    capsuleId: photo.capsuleId,
    photoId: photo.id,
    title: photo.caption.trim() || photo.capsuleTitle,
    author: photo.contributorName,
    archivedAt: photo.capturedAt,
    image: {
      kind: 'photo',
      src: photo.thumbnail,
    },
  }))
}

function createJournalWeek(
  today: Date,
  archivedMemories: JournalMemory[],
  weekOffset = 0,
): JournalDay[] {
  return [-3, -2, -1, 0, 1, 2, 3].map((relativeOffset) => {
    const dayOffset = weekOffset * 7 + relativeOffset
    const dateValue = addLocalDays(today, dayOffset)
    const isoDate = toLocalIsoDate(dateValue)
    const shortDay = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
    }).format(dateValue)
    const archivedMemoryIds = archivedMemories
      .filter((memory) => {
        const createdAt = new Date(memory.archivedAt ?? '')
        return (
          !Number.isNaN(createdAt.getTime()) &&
          toLocalIsoDate(createdAt) === isoDate
        )
      })
      .map(({ id }) => id)

    return {
      key: `${shortDay.toLowerCase()}-${dateValue.getDate()}`,
      shortDay,
      date: String(dateValue.getDate()),
      dateValue,
      isoDate,
      fullDate: formatLocalDay(dateValue),
      memoryIds: isAfterLocalDay(dateValue, today)
        ? []
        : [
            ...(demoMemoryIdsByOffset.get(dayOffset) ?? []),
            ...archivedMemoryIds,
          ],
    }
  })
}

function journalDayKey(date: Date) {
  const shortDay = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
  }).format(date)
  return `${shortDay.toLowerCase()}-${date.getDate()}`
}

function journalWeekRange(days: JournalDay[]) {
  const first = days[0]?.dateValue
  const last = days.at(-1)?.dateValue
  if (!first || !last) return 'Journal week'
  const firstLabel = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(first)
  const lastLabel = new Intl.DateTimeFormat('en', {
    month: first.getMonth() === last.getMonth() ? undefined : 'short',
    day: 'numeric',
  }).format(last)
  return `${firstLabel} – ${lastLabel}`
}

function getMemoryCountLabel(count: number) {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`
}

function JournalMemoryImage({ memory }: { memory: JournalMemory }) {
  if (memory.image.kind === 'photo') {
    return (
      <span className="journal-memory__image-frame" aria-hidden="true">
        <CapsulePhotoImage
          className="journal-memory__image"
          source={memory.image.src}
          alt=""
        />
      </span>
    )
  }

  if (memory.image.kind === 'placeholder') {
    return (
      <span
        className="journal-memory__image-frame journal-memory__image-frame--placeholder"
        aria-hidden="true"
      >
        <span>360°</span>
      </span>
    )
  }

  const contactSheetStyle = {
    '--journal-sheet-x': `${memory.image.column * -100}%`,
    '--journal-sheet-y': `${memory.image.row * -100}%`,
  } as CSSProperties

  return (
    <span
      className="journal-memory__image-frame journal-memory__image-frame--contact-sheet"
      aria-hidden="true"
    >
      <img
        className="journal-memory__image journal-memory__image--contact-sheet"
        src={memory.image.src}
        alt=""
        draggable="false"
        style={contactSheetStyle}
      />
    </span>
  )
}

type JournalPageProps = {
  now?: Date
  sharedMoments?: PanoramaMoment[]
  capsules?: FamilyCapsule[]
  capsuleNow?: Date
}

export function JournalPage({
  now = new Date(),
  sharedMoments = [],
  capsules = [],
  capsuleNow = now,
}: JournalPageProps = {}) {
  const location = useLocation()
  const [today] = useState(() => startOfLocalDay(now))
  const incomingContext = (location.state as JournalLocationState | null)
    ?.journalContext
  const initialWeekOffset =
    typeof incomingContext?.weekOffset === 'number' &&
    Number.isInteger(incomingContext.weekOffset)
      ? Math.min(0, incomingContext.weekOffset)
      : 0
  const [weekOffset, setWeekOffset] = useState(initialWeekOffset)
  const sharedJournalMemories = useMemo(
    () => sharedMoments.map(toSharedJournalMemory),
    [sharedMoments],
  )
  const capsuleJournalMemories = useMemo(
    () => toCapsuleJournalMemories(capsules, capsuleNow),
    [capsuleNow, capsules],
  )
  const archivedJournalMemories = useMemo(
    () => [...sharedJournalMemories, ...capsuleJournalMemories],
    [capsuleJournalMemories, sharedJournalMemories],
  )
  const allJournalMemories = useMemo(
    () => [...journalMemories, ...archivedJournalMemories],
    [archivedJournalMemories],
  )
  const journalWeek = useMemo(
    () => createJournalWeek(today, archivedJournalMemories, weekOffset),
    [archivedJournalMemories, today, weekOffset],
  )
  const defaultJournalDay = weekOffset === 0
    ? journalWeek.find(({ isoDate }) => isoDate === toLocalIsoDate(today))
      ?? journalWeek[3]
    : journalWeek[3]
  const initialDayKey = journalWeek.some(
    ({ key }) => key === incomingContext?.selectedDayKey,
  )
    ? incomingContext?.selectedDayKey ?? defaultJournalDay.key
    : defaultJournalDay.key
  const initialScrollTop =
    typeof incomingContext?.scrollTop === 'number'
      ? Math.max(0, incomingContext.scrollTop)
      : 0
  const pageRef = useRef<HTMLElement>(null)
  const [selectedDayKey, setSelectedDayKey] = useState(initialDayKey)
  const [scrollTop, setScrollTop] = useState(initialScrollTop)

  const selectedDay =
    journalWeek.find(({ key }) => key === selectedDayKey) ?? defaultJournalDay
  const isFutureDay = isAfterLocalDay(selectedDay.dateValue, today)
  const selectedMemories = (isFutureDay ? [] : selectedDay.memoryIds)
    .map((memoryId) => allJournalMemories.find(({ id }) => id === memoryId))
    .filter((memory): memory is JournalMemory => Boolean(memory))
  const memoryCount = getMemoryCountLabel(selectedMemories.length)

  useEffect(() => {
    if (!incomingContext) return

    const frame = window.requestAnimationFrame(() => {
      if (pageRef.current) {
        pageRef.current.scrollTop = initialScrollTop
      }
      if (incomingContext.focusMemoryId) {
        document
          .querySelector<HTMLElement>(
            `[data-journal-memory-id="${incomingContext.focusMemoryId}"]`,
          )
          ?.focus({ preventScroll: true })
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [incomingContext, initialScrollTop])

  function selectDay(dayKey: string) {
    setSelectedDayKey(dayKey)
  }

  function showWeek(nextWeekOffset: number) {
    const boundedOffset = Math.min(0, nextWeekOffset)
    setWeekOffset(boundedOffset)
    setSelectedDayKey(
      journalDayKey(addLocalDays(today, boundedOffset * 7)),
    )
  }

  function rememberScroll(event: UIEvent<HTMLElement>) {
    setScrollTop(event.currentTarget.scrollTop)
  }

  return (
    <section
      ref={pageRef}
      className="journal-page"
      aria-labelledby="journal-title"
      onScroll={rememberScroll}
    >
      <header className="journal-page__header">
        <div className="journal-page__heading">
          <p className="journal-page__eyebrow">Our family</p>
          <h1 id="journal-title">Memory Journal</h1>
          <p>Moments from your circle, kept day by day.</p>
        </div>
      </header>

      <JournalEventsSection />

      <nav className="journal-week" aria-label="Journal week">
        <div className="journal-week__toolbar">
          <button
            type="button"
            aria-label="Show previous seven days"
            onClick={() => showWeek(weekOffset - 1)}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            className="journal-week__range"
            aria-label={
              weekOffset === 0
                ? `Current journal week, ${journalWeekRange(journalWeek)}`
                : `Return to today from ${journalWeekRange(journalWeek)}`
            }
            disabled={weekOffset === 0}
            onClick={() => showWeek(0)}
          >
            {weekOffset === 0 ? 'This week' : journalWeekRange(journalWeek)}
          </button>
          <button
            type="button"
            aria-label="Show next seven days"
            disabled={weekOffset === 0}
            onClick={() => showWeek(weekOffset + 1)}
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
        <ol className="journal-week__days">
          {journalWeek.map((day) => {
            const isSelected = selectedDay.key === day.key
            const isFuture = isAfterLocalDay(day.dateValue, today)
            const countLabel = getMemoryCountLabel(
              isFuture ? 0 : day.memoryIds.length,
            )

            return (
              <li key={day.key}>
                <button
                  type="button"
                  className="journal-week__day"
                  aria-label={`${day.fullDate}, ${countLabel}`}
                  aria-pressed={isSelected}
                  data-future={isFuture ? 'true' : 'false'}
                  onClick={() => selectDay(day.key)}
                >
                  <span className="journal-week__weekday" aria-hidden="true">{day.shortDay}</span>
                  <time dateTime={day.isoDate} aria-hidden="true">{day.date}</time>
                  <span className="journal-week__marker" aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <section className="journal-day" aria-labelledby="journal-day-title">
        <header className="journal-day__header">
          <div>
            <h2 id="journal-day-title">{selectedDay.fullDate}</h2>
            <p aria-live="polite">{memoryCount}</p>
          </div>
        </header>

        <ul className="journal-memories" data-layout="grid">
          {selectedMemories.map((memory) => {
            const isCapsulePhoto = memory.kind === 'capsule-photo'
            const sourceMemoryId = isCapsulePhoto
              ? memory.photoId
              : memory.memoryId
            const destination = isCapsulePhoto
              ? `/journal/photo/${encodeURIComponent(memory.capsuleId)}/${encodeURIComponent(memory.photoId)}`
              : `/memory/${memory.memoryId}`

            return (
              <li key={`${selectedDay.key}-${memory.id}`}>
                <Link
                  className="journal-memory__link"
                  to={destination}
                  state={{
                    returnTo: '/journal',
                    sourceMemoryId,
                    journalContext: {
                      selectedDayKey,
                      view: 'grid',
                      scrollTop,
                      weekOffset,
                      focusMemoryId: memory.id,
                    },
                  }}
                  data-journal-memory-id={memory.id}
                  aria-label={`Open ${memory.title}, shared by ${memory.author}, ${
                    isCapsulePhoto ? 'photo memory' : 'panorama memory'
                  }`}
                >
                  <article className="journal-memory">
                    <JournalMemoryImage memory={memory} />
                  </article>
                </Link>
              </li>
            )
          })}
        </ul>

        {isFutureDay ? (
          <p className="journal-day__empty" role="status">
            Moments from this day will appear here after they’re shared.
          </p>
        ) : null}
      </section>
    </section>
  )
}
