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
