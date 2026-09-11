import { describe, expect, it } from 'vitest'
import type { CapsulePhoto, FamilyCapsule } from '../capsules/types'
import {
  isSelectiveContributionWindow,
  selectBubbleWidget,
  selectBubbleWidgetTimeline,
  type SelectBubbleWidgetInput,
  type WidgetEvent,
} from './widgetSnapshot'

const now = new Date(2026, 8, 11, 18, 0, 0)

function at(hours: number, minutes = 0) {
  return new Date(2026, 8, 11, hours, minutes, 0).toISOString()
}

function event(overrides: Partial<WidgetEvent> = {}): WidgetEvent {
  return {
    id: 'event-1',
    title: 'Family dinner',
    startsAt: at(21),
    location: 'Grandma’s house',
    tasks: [],
    ...overrides,
  }
}

function photo(overrides: Partial<CapsulePhoto> = {}): CapsulePhoto {
  return {
    id: 'photo-1',
    capsuleId: 'capsule-1',
    image: 'https://example.test/full.jpg',
    thumbnail: 'https://example.test/thumb.jpg',
    width: 1200,
    height: 900,
    caption: 'Sunday dinner',
    capturedAt: at(17),
    contributorName: 'Mum',
    ownedByCurrentUser: false,
    syncStatus: 'synced',
    ...overrides,
  }
}

function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return {
    id: 'capsule-1',
    kind: 'weekly',
    title: 'This week',
    createdAt: new Date(2026, 8, 7).toISOString(),
    closesAt: at(17),
    opensAt: at(17),
    createdByName: 'Family',
    photos: [photo()],
    familySynced: true,
    ...overrides,
  }
}

function select(overrides: Partial<SelectBubbleWidgetInput> = {}) {
  return selectBubbleWidget({
    now,
    theme: 'plum',
    privacy: 'full',
    events: [],
    authorizedCapsules: [],
    ...overrides,
  })
}

describe('selectBubbleWidget', () => {
  it('puts an incomplete task due within two hours ahead of a new recap', () => {
    const result = select({
      events: [event({
        startsAt: at(19, 30),
        tasks: [
          { id: 'done', label: 'Already packed' },
          { id: 'next', label: 'Bring the cake' },
          { id: 'later', label: 'Pick up flowers' },
        ],
        completedTaskIds: ['done'],
      })],
      authorizedCapsules: [capsule()],
    })

    expect(result.snapshot).toMatchObject({
      version: 1,
      kind: 'urgent',
      theme: 'plum',
      eyebrow: 'Due soon',
      title: 'Bring the cake',
      badge: '+1',
      route: '/journal?section=plans',
      privacy: 'full',
    })
    expect(result.thumbnail).toBeUndefined()
  })

  it('puts an unviewed Capsule opened today ahead of an ordinary plan', () => {
    const result = select({
      events: [event()],
      authorizedCapsules: [capsule()],
    })

    expect(result.snapshot.kind).toBe('unlock')
    expect(result.snapshot.title).toBe('This week is ready')
    expect(result.snapshot.route).toContain('recap=capsule-1')
    expect(result.thumbnail).toBe('https://example.test/thumb.jpg')
  })

  it('restores the next ordinary task after that recap is viewed', () => {
    const result = select({
      events: [event({
        tasks: [
          { id: 'one', label: 'Buy candles' },
          { id: 'two', label: 'Call the bakery' },
        ],
      })],
      authorizedCapsules: [capsule()],
      viewedRecapIds: new Set(['capsule-1']),
    })

    expect(result.snapshot).toMatchObject({
      kind: 'today',
      title: 'Buy candles',
      badge: '+1',
    })
  })

  it('keeps an incomplete task visible for the rest of its calendar day', () => {
    const result = select({
      events: [event({
        startsAt: at(14),
        tasks: [{ id: 'follow-up', label: 'Send the family photos' }],
      })],
    })

    expect(result.snapshot).toMatchObject({
      kind: 'today',
      title: 'Send the family photos',
    })
  })

  it('does not turn a fully completed checklist back into an event action', () => {
    const result = select({
      events: [event({
        tasks: [{ id: 'done', label: 'Done already' }],
        completedTaskIds: ['done'],
      })],
    })

    expect(result.snapshot.kind).toBe('empty')
  })

  it('uses the selective contribution prompt only when explicitly eligible', () => {
    const collecting = capsule({
      closesAt: new Date(2026, 8, 12, 20).toISOString(),
      opensAt: new Date(2026, 8, 13, 8).toISOString(),
      photos: [],
    })

    expect(select({ authorizedCapsules: [collecting] }).snapshot.kind).toBe('empty')
    expect(select({
      authorizedCapsules: [collecting],
      allowContributionPrompt: true,
    }).snapshot).toMatchObject({
      kind: 'capture',
      title: 'A little moment?',
      route: '/capsule?contribute=capsule-1',
    })
  })

  it('uses only a synced photo from a service-authorized opened Capsule', () => {
    const pending = capsule({
      id: 'pending-capsule',
      opensAt: new Date(2026, 8, 10, 9).toISOString(),
      closesAt: new Date(2026, 8, 10, 8).toISOString(),
      photos: [photo({ id: 'pending-photo', syncStatus: 'pending' })],
    })
    const opened = capsule({
      id: 'opened-capsule',
      weekStart: '2026-08-31',
      opensAt: new Date(2026, 8, 7, 0).toISOString(),
      closesAt: new Date(2026, 8, 7, 0).toISOString(),
      photos: [photo({
        id: 'opened-photo',
        capsuleId: 'opened-capsule',
        thumbnail: 'https://example.test/authorized.jpg',
      })],
    })

    const result = select({ authorizedCapsules: [pending, opened] })
    expect(result.snapshot.kind).toBe('memory')
    expect(result.snapshot.route).toBe(
      '/journal/photo/opened-capsule/opened-photo',
    )
    expect(result.thumbnail).toBe('https://example.test/authorized.jpg')
  })

  it('uses last week instead of an older weekly or special Capsule', () => {
    const lastWeek = capsule({
      id: 'last-week',
      kind: 'weekly',
      weekStart: '2026-08-31',
      opensAt: new Date(2026, 8, 7, 0).toISOString(),
      closesAt: new Date(2026, 8, 7, 0).toISOString(),
      photos: [photo({ id: 'weekly-photo', capsuleId: 'last-week' })],
    })
    const older = capsule({
      id: 'older-weekly',
      weekStart: '2026-08-24',
      opensAt: new Date(2026, 7, 31, 0).toISOString(),
      closesAt: new Date(2026, 7, 31, 0).toISOString(),
      photos: [photo({ id: 'older-photo', capsuleId: 'older-weekly' })],
    })
    const special = capsule({
      id: 'birthday',
      kind: 'special',
      opensAt: new Date(2026, 8, 10, 9).toISOString(),
      closesAt: new Date(2026, 8, 10, 8).toISOString(),
      photos: [photo({ id: 'birthday-photo', capsuleId: 'birthday' })],
    })

    expect(select({ authorizedCapsules: [special, older, lastWeek] }).snapshot.route).toBe(
      '/journal/photo/last-week/weekly-photo',
    )
  })

  it.each(['image', 'photo', 'IMG_4065.PNG', 'FullSizeRender.jpg'])('replaces generic caption %s with readable widget copy', (caption) => {
    const lastWeek = capsule({
      weekStart: '2026-08-31',
      opensAt: new Date(2026, 8, 7, 0).toISOString(),
      closesAt: new Date(2026, 8, 7, 0).toISOString(),
      photos: [photo({ caption })],
    })
    expect(select({ authorizedCapsules: [lastWeek] }).snapshot).toMatchObject({
      kind: 'memory',
      eyebrow: 'Last week',
      title: 'A little memory',
      subtitle: 'Mum',
    })
  })

  it('falls through to calm empty when last week has no synced photo', () => {
    const older = capsule({
      id: 'older-weekly',
      weekStart: '2026-08-24',
      opensAt: new Date(2026, 7, 31, 0).toISOString(),
      closesAt: new Date(2026, 7, 31, 0).toISOString(),
    })
    const lastWeek = capsule({
      id: 'last-week',
      weekStart: '2026-08-31',
      opensAt: new Date(2026, 8, 7, 0).toISOString(),
      closesAt: new Date(2026, 8, 7, 0).toISOString(),
      photos: [photo({ syncStatus: 'pending' })],
    })

    expect(select({ authorizedCapsules: [older, lastWeek] }).snapshot.kind).toBe('empty')
  })

  it('never reveals a photo from a locked or local-only Capsule', () => {
    const locked = capsule({
      opensAt: new Date(2026, 8, 12, 9).toISOString(),
      closesAt: new Date(2026, 8, 12, 8).toISOString(),
    })
    const localOnly = capsule({
      opensAt: new Date(2026, 8, 10, 9).toISOString(),
      closesAt: new Date(2026, 8, 10, 8).toISOString(),
      familySynced: false,
    })

    const result = select({ authorizedCapsules: [locked, localOnly] })
    expect(result.snapshot.kind).toBe('empty')
    expect(result.thumbnail).toBeUndefined()
  })

  it('removes private copy and media in hidden mode', () => {
    const result = select({
      privacy: 'hidden',
      authorizedCapsules: [capsule()],
    })

    expect(result.snapshot).toMatchObject({
      kind: 'unlock',
      eyebrow: 'Bubble',
      title: 'A Capsule is ready',
      subtitle: 'Open Bubble to see details',
      privacy: 'hidden',
    })
    expect(result.thumbnail).toBeUndefined()
  })

  it('also hides the remaining-item count in private mode', () => {
    const result = select({
      privacy: 'hidden',
      events: [event({
        startsAt: at(19),
        tasks: [
          { id: 'one', label: 'Private task' },
          { id: 'two', label: 'Another private task' },
        ],
      })],
    })

    expect(result.snapshot.kind).toBe('urgent')
    expect(result.snapshot.badge).toBeUndefined()
  })

  it('requests refresh at the two-hour urgency boundary', () => {
    const startsAt = new Date(now.getTime() + (3 * 60 * 60 * 1_000))
    const result = select({ events: [event({ startsAt: startsAt.toISOString() })] })

    expect(result.snapshot.kind).toBe('today')
    expect(result.snapshot.nextRefreshAt).toBe(
      new Date(startsAt.getTime() - (2 * 60 * 60 * 1_000)).toISOString(),
    )
  })

  it('requests refresh when the early-evening contribution window opens', () => {
    const beforePromptWindow = new Date(2026, 8, 11, 16, 30)
    const result = select({ now: beforePromptWindow })

    expect(result.snapshot.nextRefreshAt).toBe(
      new Date(2026, 8, 11, 17, 0).toISOString(),
    )
  })

  it('requests refresh when the early-evening contribution window closes', () => {
    const duringPromptWindow = new Date(2026, 8, 11, 18, 30)
    const result = select({ now: duringPromptWindow })

    expect(result.snapshot.nextRefreshAt).toBe(
      new Date(2026, 8, 11, 21, 0).toISOString(),
    )
  })

  it('returns a stable empty card when nothing is actionable', () => {
    expect(select().snapshot).toMatchObject({
      kind: 'empty',
      title: 'Nothing pressing today',
      route: '/',
    })
  })
})

describe('isSelectiveContributionWindow', () => {
  it('opens only during early evening', () => {
    expect(isSelectiveContributionWindow(new Date(2026, 8, 11, 16, 59))).toBe(false)
    expect(isSelectiveContributionWindow(new Date(2026, 8, 11, 17, 0))).toBe(true)
    expect(isSelectiveContributionWindow(new Date(2026, 8, 11, 20, 59))).toBe(true)
    expect(isSelectiveContributionWindow(new Date(2026, 8, 11, 21, 0))).toBe(false)
  })
})

describe('selectBubbleWidgetTimeline', () => {
  it('precomputes the due-soon transition and its event-start transition', () => {
    const selection = selectBubbleWidgetTimeline({
      now: new Date(2026, 8, 11, 16, 30),
      theme: 'plum',
      privacy: 'full',
      events: [event({ startsAt: at(19) })],
      authorizedCapsules: [],
    })

    expect(selection.snapshot.kind).toBe('today')
    expect(selection.snapshot.schedule).toEqual([
      expect.objectContaining({
        effectiveAt: at(17),
        kind: 'urgent',
        title: 'Family dinner',
      }),
      expect.objectContaining({
        effectiveAt: at(19),
        kind: 'today',
        title: 'Family dinner',
      }),
    ])
  })

  it('opens and closes the selective contribution prompt while suspended', () => {
    const collecting = capsule({
      closesAt: new Date(2026, 8, 12, 20).toISOString(),
      opensAt: new Date(2026, 8, 13, 8).toISOString(),
      photos: [],
    })
    const selection = selectBubbleWidgetTimeline({
      now: new Date(2026, 8, 11, 16, 30),
      theme: 'plum',
      privacy: 'full',
      events: [],
      authorizedCapsules: [collecting],
      contributionPromptsEnabled: true,
    })

    expect(selection.snapshot.kind).toBe('empty')
    expect(selection.snapshot.schedule).toEqual([
      expect.objectContaining({ effectiveAt: at(17), kind: 'capture' }),
      expect.objectContaining({ effectiveAt: at(21), kind: 'empty' }),
    ])
  })

  it('keeps a future Capsule reveal text-only and inside the generated day', () => {
    const future = capsule({
      closesAt: at(19),
      opensAt: at(20),
    })
    const selection = selectBubbleWidgetTimeline({
      now: new Date(2026, 8, 11, 18, 0),
      theme: 'plum',
      privacy: 'full',
      events: [],
      authorizedCapsules: [future],
      contributionPromptsEnabled: true,
    })

    expect(selection.thumbnail).toBeUndefined()
    expect(selection.snapshot.schedule).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effectiveAt: at(20),
        kind: 'unlock',
        title: 'This week is ready',
      }),
    ]))
    expect(JSON.stringify(selection.snapshot.schedule)).not.toContain('thumbnail')
    expect(selection.snapshot.schedule?.every((entry) => (
      new Date(entry.effectiveAt).getTime()
        < new Date(2026, 8, 12).getTime()
    ))).toBe(true)
  })

  it('bounds and orders the native payload below the shared 32 KiB limit', () => {
    const futureCapsules = Array.from({ length: 20 }, (_, index) => {
      const opensAt = new Date(2026, 8, 11, 10, index * 5)
      return capsule({
        id: `capsule-${index}`,
        title: `Family recap ${index}`,
        closesAt: opensAt.toISOString(),
        opensAt: opensAt.toISOString(),
        photos: [],
      })
    })
    const selection = selectBubbleWidgetTimeline({
      now: new Date(2026, 8, 11, 9, 0),
      theme: 'midnight',
      privacy: 'full',
      events: [],
      authorizedCapsules: futureCapsules,
      contributionPromptsEnabled: true,
    })
    const effectiveTimes = selection.snapshot.schedule?.map(
      (entry) => new Date(entry.effectiveAt).getTime(),
    ) ?? []

    expect(effectiveTimes).toHaveLength(12)
    expect(effectiveTimes).toEqual([...effectiveTimes].sort((a, b) => a - b))
    expect(new TextEncoder().encode(
      JSON.stringify(selection.snapshot),
    ).byteLength).toBeLessThan(32 * 1_024)
  })
})

describe('widget browsing pages', () => {
  function timeline(overrides: Partial<SelectBubbleWidgetInput> = {}) {
    return selectBubbleWidgetTimeline({
      now,
      theme: 'plum',
      privacy: 'full',
      events: [],
      authorizedCapsules: [],
      ...overrides,
    })
  }

  function lastWeek(overrides: Partial<FamilyCapsule> = {}) {
    return capsule({
      id: 'last-week',
      weekStart: '2026-08-31',
      opensAt: new Date(2026, 8, 7).toISOString(),
      closesAt: new Date(2026, 8, 7).toISOString(),
      photos: [photo({
        capsuleId: 'last-week',
        capturedAt: new Date(2026, 8, 6, 18).toISOString(),
      })],
      ...overrides,
    })
  }

  it('keeps tasks and last week’s photos browsable alongside the automatic urgent card', () => {
    const selection = timeline({
      events: [event({
        startsAt: at(19),
        tasks: [{ id: 'cake', label: 'Bring the cake' }],
      })],
      authorizedCapsules: [lastWeek()],
    })

    expect(selection.snapshot.kind).toBe('urgent')
    expect(selection.snapshot.pages).toEqual([
      expect.objectContaining({
        group: 'tasks', title: 'Bring the cake', route: '/journal?section=plans',
      }),
      expect.objectContaining({
        group: 'photos', title: 'Sunday dinner', route: '/journal/photo/last-week/photo-1',
      }),
    ])
    const photoPage = selection.snapshot.pages?.find((page) => page.group === 'photos')
    expect(photoPage).toBeDefined()
    expect(selection.pageThumbnails?.[photoPage!.id]).toBe('https://example.test/thumb.jpg')
    expect(JSON.stringify(selection.snapshot.pages)).not.toContain('https://')
  })

  it('bounds the deck to four tasks, two recaps, six photos, and eight media sources', () => {
    const recentRecaps = Array.from({ length: 3 }, (_, index) => capsule({
      id: `recap-${index}`,
      kind: 'special',
      opensAt: at(17, index),
      photos: [photo({ thumbnail: `https://example.test/recap-${index}.jpg` })],
    }))
    const selection = timeline({
      events: [event({
        tasks: Array.from({ length: 8 }, (_, index) => ({
          id: `task-${index}`, label: `Task ${index}`,
        })),
      })],
      authorizedCapsules: [
        ...recentRecaps,
        lastWeek({
          photos: Array.from({ length: 10 }, (_, index) => photo({
            id: `memory-${index}`,
            capsuleId: 'last-week',
            capturedAt: new Date(2026, 8, 6, 12, index).toISOString(),
            thumbnail: `https://example.test/memory-${index}.jpg`,
          })),
        }),
      ],
    })
    const pages = selection.snapshot.pages ?? []

    expect(pages).toHaveLength(12)
    expect(pages.filter((page) => page.group === 'tasks')).toHaveLength(4)
    expect(pages.filter((page) => page.group === 'recap')).toHaveLength(2)
    expect(pages.filter((page) => page.group === 'photos')).toHaveLength(6)
    expect(new Set(pages.map((page) => page.id)).size).toBe(12)
    expect(Object.keys(selection.pageThumbnails ?? {})).toHaveLength(8)
    expect(Object.keys(selection.pageThumbnails ?? {})).toEqual(
      pages.filter((page) => page.group !== 'tasks').map((page) => page.id),
    )
  })

  it('strips the entire deck, media sources, and sensitive copy when previews are hidden', () => {
    const selection = timeline({
      privacy: 'hidden',
      events: [event({ tasks: [{ id: 'private-task', label: 'Private appointment' }] })],
      authorizedCapsules: [
        capsule({ title: 'Private celebration' }),
        lastWeek({ photos: [photo({ caption: 'Private caption' })] }),
      ],
    })

    expect(selection.snapshot.pages).toBeUndefined()
    expect(selection.pageThumbnails).toBeUndefined()
    expect(selection.thumbnail).toBeUndefined()
    expect(JSON.stringify(selection)).not.toMatch(/Private|https:\/\//)
    expect(selection.snapshot.privacy).toBe('hidden')
    expect(selection.snapshot.schedule?.every((entry) => entry.privacy === 'hidden')).toBe(true)
  })

  it('excludes locked and local-only Capsules and photos that are not synced or dated', () => {
    const selection = timeline({
      authorizedCapsules: [
        capsule({
          id: 'locked', title: 'Locked secret',
          opensAt: new Date(2026, 8, 12, 13).toISOString(),
          closesAt: new Date(2026, 8, 12, 13).toISOString(),
          photos: [photo({ thumbnail: 'https://example.test/locked.jpg' })],
        }),
        capsule({
          id: 'local-only', title: 'Local secret', familySynced: false,
          photos: [photo({ thumbnail: 'https://example.test/local-only.jpg' })],
        }),
        lastWeek({
          photos: [
            photo({ id: 'allowed', caption: 'Shared memory', thumbnail: 'https://example.test/allowed.jpg' }),
            photo({ id: 'pending', syncStatus: 'pending', thumbnail: 'https://example.test/pending.jpg' }),
            photo({ id: 'undated', capturedAt: 'invalid-date', thumbnail: 'https://example.test/undated.jpg' }),
          ],
        }),
      ],
    })

    expect(selection.snapshot.pages).toEqual([
      expect.objectContaining({ group: 'photos', route: '/journal/photo/last-week/allowed' }),
    ])
    expect(Object.values(selection.pageThumbnails ?? {})).toEqual(['https://example.test/allowed.jpg'])
    expect(JSON.stringify(selection)).not.toMatch(/Locked secret|Local secret|locked\.jpg|local-only\.jpg|pending\.jpg|undated\.jpg/)
  })

  it('omits completed checklists and future-day tasks while keeping today’s remaining actions', () => {
    const selection = timeline({
      events: [
        event({
          id: 'today', tasks: [
            { id: 'done', label: 'Finished task' },
            { id: 'remaining', label: 'Today’s task' },
          ], completedTaskIds: ['done'],
        }),
        event({
          id: 'all-done', title: 'Completed plan',
          tasks: [{ id: 'complete', label: 'Finished checklist' }],
          completedTaskIds: ['complete'],
        }),
        event({
          id: 'tomorrow', startsAt: new Date(2026, 8, 12, 9).toISOString(),
          tasks: [{ id: 'tomorrow-task', label: 'Tomorrow’s task' }],
        }),
        event({ id: 'event-only', title: 'Dinner together', startsAt: at(22) }),
      ],
    })

    expect(selection.snapshot.pages?.map((page) => page.title)).toEqual([
      'Today’s task', 'Dinner together',
    ])
    expect(selection.snapshot.pages?.every((page) => page.group === 'tasks')).toBe(true)
  })

  it('keeps task page IDs stable when labels change and tasks or events are reordered', () => {
    const original = [
      event({
        id: 'first-event',
        tasks: [{ id: 'one', label: 'Original one' }, { id: 'two', label: 'Original two' }],
      }),
      event({ id: 'second-event', tasks: [{ id: 'one', label: 'Other event task' }] }),
    ]
    const before = timeline({ events: original }).snapshot.pages ?? []
    const after = timeline({ events: [
      original[1],
      { ...original[0], tasks: [{ id: 'two', label: 'Renamed two' }, { id: 'one', label: 'Renamed one' }] },
    ] }).snapshot.pages ?? []
    const idFor = (pages: typeof before, title: string) => pages.find((page) => page.title === title)?.id

    expect(before).toHaveLength(3)
    expect(after).toHaveLength(3)
    expect(idFor(after, 'Renamed one')).toBe(idFor(before, 'Original one'))
    expect(idFor(after, 'Renamed two')).toBe(idFor(before, 'Original two'))
    expect(idFor(after, 'Other event task')).toBe(idFor(before, 'Other event task'))
    expect(new Set(before.map((page) => page.id)).size).toBe(3)
    expect(new Set(after.map((page) => page.id))).toEqual(new Set(before.map((page) => page.id)))
  })

  it('keeps a viewed recap browsable without repeating it as the automatic card', () => {
    const selection = timeline({
      events: [event({ startsAt: at(21) })],
      authorizedCapsules: [capsule({ id: 'viewed-recap', kind: 'special', title: 'Demo day' })],
      viewedRecapIds: new Set(['viewed-recap']),
    })

    expect(selection.snapshot.kind).toBe('today')
    expect(selection.snapshot.title).toBe('Family dinner')
    expect(selection.snapshot.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: 'recap',
        title: 'Demo day is ready',
        route: '/capsule?recap=viewed-recap&source=widget',
      }),
    ]))
  })
})
