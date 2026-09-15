import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WidgetSnapshotPublisher } from './WidgetSnapshotPublisher'
import { BUBBLE_WIDGET_DATA_CHANGED_EVENT } from './widgetStorage'
import type { BubbleWidgetSnapshot } from './widgetSnapshot'
import { flightStorageKey, writeTrackedFlights } from '../flights/flightStorage'
import type { TrackedFlight } from '../flights/types'

const mocks = vi.hoisted(() => ({
  privacy: 'full' as 'full' | 'hidden',
  fetchEvents: vi.fn(),
  fetchCapsules: vi.fn(),
  fetchJournalPhotos: vi.fn(),
  fetchFlights: vi.fn<() => Promise<TrackedFlight[]>>(),
  subscribeJournalPhotos: vi.fn(async (_onChange: () => void, _subject: string): Promise<() => void> => () => undefined),
  update: vi.fn<(snapshot: BubbleWidgetSnapshot, thumbnail?: string, pages?: Readonly<Record<string, string>>) => Promise<boolean>>(async () => true),
  clear: vi.fn(async () => true),
  thumbnail: vi.fn<(source: unknown, signal?: AbortSignal) => Promise<string | undefined>>(async () => undefined),
}))

vi.mock('../../theme/AppTheme', () => ({
  useAppTheme: () => ({ theme: 'plum' }),
}))

vi.mock('../events/eventService', () => ({
  fetchFamilyEvents: mocks.fetchEvents,
  subscribeToFamilyEvents: async () => () => undefined,
}))

vi.mock('../capsules/capsuleService', () => ({
  fetchFamilyCapsules: mocks.fetchCapsules,
  subscribeToFamilyCapsules: async () => () => undefined,
}))

vi.mock('../journal/journalPhotoService', () => ({
  fetchFamilyJournalPhotos: mocks.fetchJournalPhotos,
  subscribeToFamilyJournalPhotos: mocks.subscribeJournalPhotos,
}))

vi.mock('../flights/flightStatusService', () => ({
  fetchFamilyFlights: mocks.fetchFlights,
  subscribeToFamilyFlights: async () => () => undefined,
}))

vi.mock('./nativeBubbleWidget', () => ({
  isNativeBubbleWidgetAvailable: () => true,
  updateNativeBubbleWidget: mocks.update,
  clearNativeBubbleWidget: mocks.clear,
}))

vi.mock('./widgetThumbnail', () => ({
  materializeWidgetThumbnail: mocks.thumbnail,
}))

vi.mock('./widgetStorage', async (importOriginal) => {
  const original = await importOriginal<typeof import('./widgetStorage')>()
  return {
    ...original,
    readViewedWidgetRecaps: () => new Set<string>(),
    readWidgetChecklistProgress: () => ({}),
    readWidgetCompletedPlanIds: () => new Set<string>(),
    readWidgetLocalEvents: () => [],
    readWidgetPrivacy: () => mocks.privacy,
    readWidgetTaskDefinitions: () => ({}),
  }
})

beforeEach(() => {
  mocks.fetchJournalPhotos.mockReset().mockResolvedValue([])
  mocks.fetchFlights.mockReset().mockResolvedValue([])
  mocks.update.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  mocks.privacy = 'full'
  vi.clearAllMocks()
  mocks.thumbnail.mockReset().mockResolvedValue(undefined)
})

function familyMemory(label = '') {
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7)
  const lastWeek = new Date(monday)
  lastWeek.setDate(lastWeek.getDate() - 7)
  const idPrefix = label ? `${label.toLowerCase()}-` : ''
  return {
    id: `${idPrefix}last-week`, kind: 'weekly', title: 'Last week', familySynced: true,
    opensAt: monday.toISOString(), closesAt: monday.toISOString(),
    createdAt: lastWeek.toISOString(), createdByName: 'Family',
    photos: ['one', 'two'].map((id) => ({
      id: `${idPrefix}${id}`, capsuleId: `${idPrefix}last-week`,
      caption: `${label ? `${label} ` : ''}Memory ${id}`, contributorName: 'Mum',
      capturedAt: lastWeek.toISOString(), syncStatus: 'synced',
      thumbnail: `https://example.test/${idPrefix}${id}.jpg`,
      image: `https://example.test/full-${idPrefix}${id}.jpg`,
      width: 800, height: 600, ownedByCurrentUser: false,
    })),
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((complete) => { resolve = complete })
  return { promise, resolve }
}

async function allowPublish() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
}

function activeWidgetFlight(): TrackedFlight {
  const now = Date.now()
  const departure = new Date(now - 60 * 60_000).toISOString()
  const arrival = new Date(now + 2 * 60 * 60_000).toISOString()
  return {
    id: 'publisher-flight', travelerName: 'Private traveler', flightNumber: 'EK202',
    travelDate: departure.slice(0, 10), createdAt: departure,
    notificationEnabled: false, synced: true,
    snapshot: {
      provider: 'aerodatabox', providerFlightId: 'provider-private-id', flightNumber: 'EK202',
      status: 'In flight', dataQuality: 'estimated',
      origin: { code: 'JFK', name: null, city: 'New York', latitude: 40.64, longitude: -73.77, timeZone: 'America/New_York' },
      destination: { code: 'DXB', name: null, city: 'Dubai', latitude: 25.25, longitude: 55.36, timeZone: 'Asia/Dubai' },
      scheduledDeparture: departure, estimatedDeparture: null, actualDeparture: departure,
      scheduledArrival: arrival, estimatedArrival: arrival, actualArrival: null,
      progressPercent: 33, position: null, updatedAt: new Date(now).toISOString(),
    },
  }
}

describe('WidgetSnapshotPublisher', () => {
  it('publishes a flight map before a hanging page thumbnail, then supplements the same pages', async () => {
    const subject = 'flight-fast-publish:family:a'
    const image = deferred<string | undefined>()
    const flight = activeWidgetFlight()
    localStorage.setItem(flightStorageKey(subject), JSON.stringify([flight]))
    mocks.fetchFlights.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchJournalPhotos.mockResolvedValue([familyMemory().photos[0]])
    mocks.thumbnail.mockReturnValue(image.promise)
    const view = render(<WidgetSnapshotPublisher storageSubject={subject} />)
    try {
      await waitFor(() => expect(mocks.thumbnail).toHaveBeenCalledTimes(1))
      expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'flight', flight: expect.any(Object) }), undefined,
      )
      const pageIds = mocks.update.mock.calls.at(-1)?.[0].pages?.map((page) => page.id)
      await act(async () => image.resolve('data:image/jpeg;base64,READY_PAGE'))
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'flight' }), undefined,
        expect.objectContaining(Object.fromEntries([
          [mocks.update.mock.calls.at(-1)?.[0].pages?.find((page) => page.group === 'photos')?.id ?? '',
            'data:image/jpeg;base64,READY_PAGE'],
        ])),
      ))
      expect(mocks.update.mock.calls.at(-1)?.[0].pages?.map((page) => page.id)).toEqual(pageIds)
      const count = mocks.update.mock.calls.length
      act(() => window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT)))
      await allowPublish()
      expect(mocks.update).toHaveBeenCalledTimes(count)
      expect(mocks.thumbnail).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      localStorage.removeItem(flightStorageKey(subject))
    }
  })

  it('clears flight cards before replacement photos finish and ignores a removed flight’s late image', async () => {
    const subject = 'flight-fast-removal:family:a'
    const oldImage = deferred<string | undefined>()
    const replacementImage = deferred<string | undefined>()
    const flight = activeWidgetFlight()
    localStorage.setItem(flightStorageKey(subject), JSON.stringify([flight]))
    mocks.fetchFlights.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchJournalPhotos.mockResolvedValue([familyMemory().photos[0]])
    mocks.thumbnail.mockReturnValueOnce(oldImage.promise).mockReturnValue(replacementImage.promise)
    const view = render(<WidgetSnapshotPublisher storageSubject={subject} />)
    try {
      await waitFor(() => expect(mocks.thumbnail).toHaveBeenCalledTimes(1))
      expect(mocks.update.mock.calls.at(-1)?.[0].kind).toBe('flight')
      const oldSignal = mocks.thumbnail.mock.calls[0][1]
      await act(async () => { writeTrackedFlights(subject, []) })
      // Intervening refresh renders must not lose the pending-removal priority.
      act(() => window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT)))
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'memory' }), undefined,
      ))
      expect(mocks.update.mock.calls.at(-1)?.[0].flight).toBeUndefined()
      expect(oldSignal?.aborted).toBe(true)
      const removedAt = mocks.update.mock.calls.length
      await act(async () => oldImage.resolve('data:image/jpeg;base64,REMOVED_FLIGHT_IMAGE'))
      await allowPublish()
      expect(mocks.update.mock.calls.slice(removedAt).every(([snapshot]) => (
        snapshot.kind !== 'flight' && !snapshot.pages?.some((page) => page.kind === 'flight')
      ))).toBe(true)
      expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('REMOVED_FLIGHT_IMAGE')
      await act(async () => replacementImage.resolve('data:image/jpeg;base64,REPLACEMENT'))
      await waitFor(() => expect(mocks.update.mock.calls.at(-1)?.[1]).toBe('data:image/jpeg;base64,REPLACEMENT'))
      expect(mocks.update.mock.calls.at(-1)?.[0].kind).toBe('memory')
      expect(mocks.update.mock.calls.at(-1)?.[0].pages?.some((page) => page.kind === 'flight')).toBe(false)
    } finally {
      view.unmount()
      localStorage.removeItem(flightStorageKey(subject))
    }
  })

  it('does not republish an earlier account’s fast flight card when its photo finishes late', async () => {
    const subject = 'flight-fast-account:family:alice'
    const nextSubject = 'flight-fast-account:family:bob'
    const image = deferred<string | undefined>()
    localStorage.setItem(flightStorageKey(subject), JSON.stringify([activeWidgetFlight()]))
    mocks.fetchFlights.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchJournalPhotos.mockResolvedValueOnce([familyMemory('Alice').photos[0]]).mockResolvedValue([])
    mocks.thumbnail.mockReturnValue(image.promise)
    const view = render(<WidgetSnapshotPublisher storageSubject={subject} />)
    try {
      await waitFor(() => expect(mocks.thumbnail).toHaveBeenCalledTimes(1))
      expect(mocks.update.mock.calls.at(-1)?.[0].kind).toBe('flight')
      const boundary = mocks.update.mock.calls.length
      const signal = mocks.thumbnail.mock.calls[0][1]
      view.rerender(<WidgetSnapshotPublisher storageSubject={nextSubject} />)
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'empty' }), undefined,
      ))
      expect(signal?.aborted).toBe(true)
      await act(async () => image.resolve('data:image/jpeg;base64,ALICE_FLIGHT_PAGE'))
      await allowPublish()
      expect(JSON.stringify(mocks.update.mock.calls.slice(boundary)))
        .not.toMatch(/ALICE_FLIGHT_PAGE|Alice Memory|Private traveler|EK202|JFK|DXB|departureAt/)
      expect(mocks.clear).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      localStorage.removeItem(flightStorageKey(subject))
      localStorage.removeItem(flightStorageKey(nextSubject))
    }
  })

  it('serializes a pending fast native flight write ahead of its removal without starting photo work', async () => {
    const subject = 'flight-fast-queue:family:a'
    const nativeWrite = deferred<boolean>()
    localStorage.setItem(flightStorageKey(subject), JSON.stringify([activeWidgetFlight()]))
    mocks.fetchFlights.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchJournalPhotos.mockResolvedValue([familyMemory().photos[0]])
    mocks.thumbnail.mockImplementation(() => new Promise(() => undefined))
    mocks.update.mockReturnValueOnce(nativeWrite.promise)
    const view = render(<WidgetSnapshotPublisher storageSubject={subject} />)
    try {
      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
      await act(async () => { writeTrackedFlights(subject, []) })
      await allowPublish()
      expect(mocks.update).toHaveBeenCalledTimes(1)
      expect(mocks.thumbnail).not.toHaveBeenCalled()
      await act(async () => nativeWrite.resolve(true))
      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
      expect(mocks.update.mock.calls[0][0].kind).toBe('flight')
      expect(mocks.update.mock.calls[1][0].kind).toBe('memory')
      expect(mocks.update.mock.calls[1][0].pages?.some((page) => page.kind === 'flight')).toBe(false)
    } finally {
      view.unmount()
      localStorage.removeItem(flightStorageKey(subject))
    }
  })

  it('publishes and removes a locally tracked flight without the Flights tab or waiting for Journal photos', async () => {
    const subject = 'flight-publisher:family:local'
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchJournalPhotos.mockImplementation(() => new Promise(() => undefined))
    const pendingFlights = deferred<TrackedFlight[]>()
    mocks.fetchFlights.mockReturnValue(pendingFlights.promise)
    const view = render(<WidgetSnapshotPublisher storageSubject={subject} />)
    const flight = activeWidgetFlight()
    try {
      await act(async () => { writeTrackedFlights(subject, [flight]) })
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'flight', title: 'JFK → DXB', route: '/journal?section=flights',
          flight: expect.objectContaining({
            departureAt: flight.snapshot.actualDeparture,
            arrivalAt: flight.snapshot.estimatedArrival,
            updatedAt: flight.snapshot.updatedAt,
          }),
          retainedFlight: true,
          flightMap: expect.objectContaining({
            mode: 'estimated', start: expect.any(Object), end: expect.any(Object), marker: expect.any(Object),
          }),
          pages: [expect.objectContaining({
            kind: 'flight', group: 'flights', title: 'JFK → DXB', flight: expect.any(Object),
          })],
        }), undefined,
      ))
      expect(mocks.thumbnail).not.toHaveBeenCalled()
      expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('provider-private-id')
      await act(async () => { writeTrackedFlights(subject, []) })
      // A slower original family DB response must not restore the removed card.
      await act(async () => { pendingFlights.resolve([flight]) })
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'empty', title: 'Nothing pressing today' }), undefined,
      ))
      const last = mocks.update.mock.calls.at(-1)?.[0]
      expect(last?.flight).toBeUndefined()
      expect(last?.pages?.some((page) => page.kind === 'flight')).toBe(false)
    } finally {
      view.unmount()
      localStorage.removeItem(flightStorageKey(subject))
    }
  })

  it('removes flight details on privacy opt-out and never carries them into the next account', async () => {
    const subject = 'flight-publisher:family:private'
    const nextSubject = 'flight-publisher-bob:family:other'
    const flight = activeWidgetFlight()
    localStorage.setItem(flightStorageKey(subject), JSON.stringify([flight]))
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchFlights.mockImplementation(() => new Promise(() => undefined))
    const view = render(<WidgetSnapshotPublisher storageSubject={subject} />)
    try {
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'flight', privacy: 'full', flight: expect.any(Object) }), undefined,
      ))
      mocks.privacy = 'hidden'
      act(() => window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT)))
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'flight', privacy: 'hidden', title: 'A journey is coming up' }), undefined,
      ))
      const hidden = mocks.update.mock.calls.at(-1)?.[0]
      expect(hidden?.flight).toBeUndefined()
      expect(hidden?.flightMap).toBeUndefined()
      expect(hidden?.retainedFlight).toBeUndefined()
      expect(hidden?.expiresAt).toBeUndefined()
      expect(hidden?.pages).toBeUndefined()
      expect(JSON.stringify(hidden)).not.toMatch(/Private traveler|EK202|JFK|DXB|departureAt|arrivalAt/)

      mocks.privacy = 'full'
      const boundary = mocks.update.mock.calls.length
      view.rerender(<WidgetSnapshotPublisher storageSubject={nextSubject} />)
      await act(async () => { writeTrackedFlights(subject, [flight]) })
      await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'empty', privacy: 'full' }), undefined,
      ))
      expect(JSON.stringify(mocks.update.mock.calls.slice(boundary))).not.toMatch(/Private traveler|EK202|JFK|DXB|departureAt|arrivalAt/)
      expect(mocks.clear).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      localStorage.removeItem(flightStorageKey(subject))
      localStorage.removeItem(flightStorageKey(nextSubject))
    }
  })

  it('sources all uploaded Journal photos using the current member namespace', async () => {
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    const journalPhoto = { ...familyMemory().photos[0], id: 'journal-upload', caption: 'Years ago together' }
    mocks.fetchJournalPhotos.mockResolvedValue([journalPhoto])
    mocks.thumbnail.mockImplementation(async (source) => `data:image/jpeg;base64,${String(source)}`)
    const view = render(<WidgetSnapshotPublisher storageSubject="alice:family:a" />)

    await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'memory',
        route: '/journal?photo=journal-upload&collection=family-photo-library&source=widget',
        pages: [expect.objectContaining({ title: 'Years ago together', group: 'photos' })],
      }),
      expect.any(String),
      expect.any(Object),
    ))
    expect(mocks.fetchJournalPhotos).toHaveBeenCalledWith('alice:family:a')
    expect(mocks.subscribeJournalPhotos).toHaveBeenCalledWith(expect.any(Function), 'alice:family:a')
    view.unmount()
  })

  it('does not delay planner cards while a large Journal library is loading', async () => {
    mocks.fetchJournalPhotos.mockImplementation(() => new Promise(() => undefined))
    const startsAt = new Date()
    startsAt.setHours(12, 0, 0, 0)
    mocks.fetchEvents.mockResolvedValue([{
      id: 'event', title: 'Dinner', startsAt: startsAt.toISOString(), details: null,
    }])
    mocks.fetchCapsules.mockResolvedValue([])
    const view = render(<WidgetSnapshotPublisher storageSubject="alice:family:a" />)
    await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Dinner', route: '/journal?section=plans' }),
      undefined,
    ))
    view.unmount()
  })

  it('coalesces Journal reads during rapid preference updates without discarding the pending library', async () => {
    const photos = deferred<ReturnType<typeof familyMemory>['photos']>()
    mocks.fetchJournalPhotos.mockReturnValueOnce(photos.promise)
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    const view = render(<WidgetSnapshotPublisher storageSubject="alice:family:a" />)
    await waitFor(() => expect(mocks.fetchJournalPhotos).toHaveBeenCalledTimes(1))
    act(() => {
      for (let index = 0; index < 20; index += 1) {
        window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT))
      }
    })
    await act(async () => photos.resolve(familyMemory().photos))
    await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'memory' }), undefined,
    ))
    expect(mocks.fetchJournalPhotos).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('discards a previous family’s late Journal response after switching accounts', async () => {
    const previousFamily = deferred<ReturnType<typeof familyMemory>['photos']>()
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.fetchJournalPhotos.mockReturnValueOnce(previousFamily.promise).mockResolvedValueOnce([])
    const view = render(<WidgetSnapshotPublisher storageSubject="alice:family:a" />)
    await waitFor(() => expect(mocks.fetchJournalPhotos).toHaveBeenCalledTimes(1))
    view.rerender(<WidgetSnapshotPublisher storageSubject="bob:family:b" />)
    await waitFor(() => expect(mocks.fetchJournalPhotos).toHaveBeenCalledTimes(2))
    await act(async () => previousFamily.resolve(familyMemory('Alice').photos))
    await allowPublish()
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('Alice Memory')
    expect(mocks.thumbnail).not.toHaveBeenCalled()
    view.unmount()
  })

  it('publishes a privacy opt-out from memory before network refresh settles', async () => {
    const startsAt = new Date()
    startsAt.setHours(12, 0, 0, 0)
    mocks.fetchEvents.mockResolvedValueOnce([{
      id: 'event-1',
      title: 'Private family plan',
      startsAt: startsAt.toISOString(),
      location: 'Home',
      details: null,
    }])
    mocks.fetchCapsules.mockResolvedValueOnce([])

    const view = render(<WidgetSnapshotPublisher storageSubject="family:user" />)
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          privacy: 'full',
          title: 'Private family plan',
        }),
        undefined,
      )
    })

    mocks.fetchEvents.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchCapsules.mockImplementation(() => new Promise(() => undefined))
    mocks.privacy = 'hidden'
    act(() => {
      window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT))
    })

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          privacy: 'hidden',
          title: 'You have something today',
        }),
        undefined,
      )
    })
    expect(mocks.fetchEvents).toHaveBeenCalledTimes(2)
    expect(mocks.fetchCapsules).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('does not postpone the new account snapshot when its reads stall and its parent rerenders', async () => {
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([familyMemory('Alice')])
    const view = render(<WidgetSnapshotPublisher storageSubject="alice:family:a" />)
    await waitFor(() => expect(JSON.stringify(mocks.update.mock.calls)).toContain('Alice Memory'))
    mocks.update.mockClear()
    mocks.fetchEvents.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchCapsules.mockImplementation(() => new Promise(() => undefined))
    mocks.fetchJournalPhotos.mockImplementation(() => new Promise(() => undefined))

    view.rerender(<WidgetSnapshotPublisher storageSubject="bob:family:b" />)
    // Parent renders faster than the 180 ms debounce must not restart it.
    for (let index = 0; index < 8; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
      view.rerender(<WidgetSnapshotPublisher storageSubject="bob:family:b" />)
    }
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('Alice Memory')
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('unsubscribes a Journal listener that finishes registering after unmount', async () => {
    const registration = deferred<() => void>()
    const stop = vi.fn()
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([])
    mocks.subscribeJournalPhotos.mockReturnValueOnce(registration.promise)
    const view = render(<WidgetSnapshotPublisher storageSubject="alice:family:a" />)
    view.unmount()
    await act(async () => registration.resolve(stop))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('publishes per-page media once and keeps the selected page through identical refreshes', async () => {
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([familyMemory()])
    mocks.thumbnail.mockImplementation(async (source) => `data:image/jpeg;base64,${String(source)}`)
    const view = render(<WidgetSnapshotPublisher storageSubject="family:user" />)
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ pages: expect.arrayContaining([
        expect.objectContaining({ group: 'photos', title: 'Memory one' }),
        expect.objectContaining({ group: 'photos', title: 'Memory two' }),
      ]) }),
      expect.any(String),
      expect.any(Object),
    ))
    expect(Object.keys(mocks.update.mock.calls.at(-1)?.[2] ?? {}).length).toBeGreaterThanOrEqual(2)
    expect(mocks.thumbnail).toHaveBeenCalledTimes(2)
    const count = mocks.update.mock.calls.length
    act(() => window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT)))
    await waitFor(() => expect(mocks.fetchEvents).toHaveBeenCalledTimes(2))
    await allowPublish()
    expect(mocks.update).toHaveBeenCalledTimes(count)
    expect(mocks.thumbnail).toHaveBeenCalledTimes(2)
    expect(mocks.fetchJournalPhotos).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('aborts pending page images and never republishes them after an opt-out', async () => {
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules.mockResolvedValue([familyMemory()])
    let finish: (value: string) => void = () => undefined
    mocks.thumbnail.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const view = render(<WidgetSnapshotPublisher storageSubject="family:user" />)
    await waitFor(() => expect(mocks.thumbnail).toHaveBeenCalledTimes(1))
    const signal = mocks.thumbnail.mock.calls[0][1]
    mocks.privacy = 'hidden'
    act(() => window.dispatchEvent(new Event(BUBBLE_WIDGET_DATA_CHANGED_EVENT)))
    await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ privacy: 'hidden' }), undefined,
    ))
    expect(signal?.aborted).toBe(true)
    await act(async () => finish('data:image/jpeg;base64,PRIVATE'))
    await allowPublish()
    expect(mocks.update.mock.calls.every(([snapshot]) => snapshot.privacy === 'hidden')).toBe(true)
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('PRIVATE')
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('pages')
    view.unmount()
  })

  it('clears account thumbnails and ignores a stale materializer after a family switch', async () => {
    const aliceThumbnail = deferred<string | undefined>()
    mocks.fetchEvents.mockResolvedValue([])
    mocks.fetchCapsules
      .mockResolvedValueOnce([familyMemory('Alice')])
      .mockResolvedValueOnce([familyMemory('Bob')])
    mocks.thumbnail
      .mockImplementationOnce(() => aliceThumbnail.promise)
      .mockImplementation(async (source) => `data:image/jpeg;base64,${String(source)}`)
    const view = render(
      <WidgetSnapshotPublisher storageSubject="alice:family:a" />,
    )
    await waitFor(() => expect(mocks.thumbnail).toHaveBeenCalledTimes(1))
    const aliceSignal = mocks.thumbnail.mock.calls[0]?.[1]

    view.rerender(<WidgetSnapshotPublisher storageSubject="bob:family:b" />)

    await waitFor(() => expect(mocks.fetchCapsules).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(JSON.stringify(mocks.update.mock.calls)).toContain('Bob Memory'))
    expect(aliceSignal?.aborted).toBe(true)
    expect(mocks.clear).toHaveBeenCalledTimes(1)

    await act(async () => aliceThumbnail.resolve('data:image/jpeg;base64,ALICE_PRIVATE'))
    await allowPublish()
    const published = JSON.stringify(mocks.update.mock.calls)
    expect(published).not.toContain('ALICE_PRIVATE')
    expect(published).not.toContain('Alice Memory')
    expect(published).toContain('Bob Memory')
    view.unmount()
  })
})
