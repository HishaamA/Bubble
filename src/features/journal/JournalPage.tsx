import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
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
import type { PanoramaMoment } from '../memories/shared'
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

type JournalMemory = {
  id: string
  memoryId: string
  title: string
  author: string
  image:
    | {
        kind: 'photo'
        src: string
        position: string
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
}

const familyMemoryGridSrc = '/assets/journal/family-memory-grid-v1.png'

type JournalReturnContext = {
  selectedDayKey: string
  view: 'grid'
  scrollTop: number
  focusMemoryId?: string
}

type JournalLocationState = {
  journalContext?: Partial<JournalReturnContext>
}

const journalMemories: JournalMemory[] = [
  {
    id: 'golden-hour',
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
    memoryId: sharedJournalMemoryId(moment.id),
    title: moment.label,
    author: moment.uploaderDisplayName,
    image: moment.objectUrl
      ? { kind: 'photo', src: moment.objectUrl, position: 'center' }
      : { kind: 'placeholder' },
  }
}

function createJournalWeek(
  today: Date,
  sharedMoments: PanoramaMoment[],
): JournalDay[] {
  return [-3, -2, -1, 0, 1, 2, 3].map((offset) => {
    const dateValue = addLocalDays(today, offset)
    const isoDate = toLocalIsoDate(dateValue)
    const shortDay = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
    }).format(dateValue)
    const sharedMemoryIds = sharedMoments
      .filter((moment) => {
        const createdAt = new Date(moment.createdAt)
        return (
          !Number.isNaN(createdAt.getTime()) &&
          toLocalIsoDate(createdAt) === isoDate
        )
      })
      .map(({ id }) => sharedJournalMemoryId(id))

    return {
      key: `${shortDay.toLowerCase()}-${dateValue.getDate()}`,
      shortDay,
      date: String(dateValue.getDate()),
      dateValue,
      isoDate,
      fullDate: formatLocalDay(dateValue),
      memoryIds: isAfterLocalDay(dateValue, today)
        ? []
        : [...(demoMemoryIdsByOffset.get(offset) ?? []), ...sharedMemoryIds],
    }
  })
}

function IconFrame({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

function SparkleIcon() {
  return (
    <IconFrame>
      <path d="M8.2 3.7c.4 3 1.7 4.6 4.4 5.2-2.7.6-4 2.2-4.4 5.2-.5-3-1.8-4.6-4.5-5.2 2.7-.6 4-2.2 4.5-5.2Z" />
      <path d="M16.8 12.2c.3 2.3 1.3 3.5 3.4 4-2.1.4-3.1 1.7-3.4 4-.4-2.3-1.4-3.6-3.5-4 2.1-.5 3.1-1.7 3.5-4Z" />
    </IconFrame>
  )
}

function getMemoryCountLabel(count: number) {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`
}

function JournalMemoryImage({ memory }: { memory: JournalMemory }) {
  if (memory.image.kind === 'photo') {
    return (
      <span className="journal-memory__image-frame" aria-hidden="true">
        <img
          className="journal-memory__image"
          src={memory.image.src}
          alt=""
          draggable="false"
          style={{ objectPosition: memory.image.position }}
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
}

export function JournalPage({
  now = new Date(),
  sharedMoments = [],
}: JournalPageProps = {}) {
  const location = useLocation()
  const [today] = useState(() => startOfLocalDay(now))
  const sharedJournalMemories = useMemo(
    () => sharedMoments.map(toSharedJournalMemory),
    [sharedMoments],
  )
  const allJournalMemories = useMemo(
    () => [...journalMemories, ...sharedJournalMemories],
    [sharedJournalMemories],
  )
  const journalWeek = useMemo(
    () => createJournalWeek(today, sharedMoments),
    [sharedMoments, today],
  )
  const todayJournalDay = journalWeek[3]
  const incomingContext = (location.state as JournalLocationState | null)
    ?.journalContext
  const initialDayKey = journalWeek.some(
    ({ key }) => key === incomingContext?.selectedDayKey,
  )
    ? incomingContext?.selectedDayKey ?? todayJournalDay.key
    : todayJournalDay.key
  const initialScrollTop =
    typeof incomingContext?.scrollTop === 'number'
      ? Math.max(0, incomingContext.scrollTop)
      : 0
  const pageRef = useRef<HTMLElement>(null)
  const [selectedDayKey, setSelectedDayKey] = useState(initialDayKey)
  const [scrollTop, setScrollTop] = useState(initialScrollTop)
  const [showRecap, setShowRecap] = useState(false)

  const selectedDay =
    journalWeek.find(({ key }) => key === selectedDayKey) ?? todayJournalDay
  const isFutureDay = isAfterLocalDay(selectedDay.dateValue, today)
  const selectedMemories = (isFutureDay ? [] : selectedDay.memoryIds)
    .map((memoryId) => allJournalMemories.find(({ id }) => id === memoryId))
    .filter((memory): memory is JournalMemory => Boolean(memory))
  const memoryCount = getMemoryCountLabel(selectedMemories.length)
  const recapPreviewMemory = selectedMemories[0] ?? journalMemories[0]

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
    setShowRecap(false)
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

      <nav className="journal-week" aria-label="Journal week">
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
          {selectedMemories.map((memory) => (
            <li key={`${selectedDay.key}-${memory.id}`}>
              <Link
                className="journal-memory__link"
                to={`/memory/${memory.memoryId}`}
                state={{
                  returnTo: '/journal',
                  sourceMemoryId: memory.memoryId,
                  journalContext: {
                    selectedDayKey,
                    view: 'grid',
                    scrollTop,
                    focusMemoryId: memory.id,
                  },
                }}
                data-journal-memory-id={memory.id}
                aria-label={`Open ${memory.title}, shared by ${memory.author}, panorama memory`}
              >
                <article className="journal-memory">
                  <JournalMemoryImage memory={memory} />
                </article>
              </Link>
            </li>
          ))}
        </ul>

        {isFutureDay ? (
          <p className="journal-day__empty" role="status">
            Moments from this day will appear here after they’re shared.
          </p>
        ) : null}

        {!isFutureDay && selectedMemories.length > 0 ? (
          <div className="journal-recap">
            <button
              className="journal-recap__action"
              type="button"
              aria-expanded={showRecap}
              aria-controls="journal-recap-preview"
              onClick={() => setShowRecap((current) => !current)}
            >
              <span className="journal-recap__sparkles"><SparkleIcon /></span>
              <span>
                <strong>{showRecap ? 'Recap ready' : 'Create Recap'}</strong>
                <small>{showRecap ? 'A little film of this family day' : 'See your memories come to life'}</small>
              </span>
              <span className="journal-recap__chevron" aria-hidden="true">{showRecap ? '−' : '›'}</span>
            </button>

            {showRecap ? (
              <section
                id="journal-recap-preview"
                className="journal-recap__preview"
                role="status"
                aria-live="polite"
              >
                <div className="journal-recap__preview-image" aria-hidden="true">
                  <JournalMemoryImage memory={recapPreviewMemory} />
                </div>
                <div>
                  <p>Your family recap is ready</p>
                  <strong>{selectedDay.fullDate}</strong>
                  <span>{memoryCount} · Made from everyone’s point of view</span>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </section>
    </section>
  )
}
