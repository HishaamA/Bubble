import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WidgetSnapshotPublisher } from './WidgetSnapshotPublisher'
import { BUBBLE_WIDGET_DATA_CHANGED_EVENT } from './widgetStorage'
import type { BubbleWidgetSnapshot } from './widgetSnapshot'

const mocks = vi.hoisted(() => ({
  privacy: 'full' as 'full' | 'hidden',
  fetchEvents: vi.fn(),
  fetchCapsules: vi.fn(),
  fetchJournalPhotos: vi.fn(),
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

describe('WidgetSnapshotPublisher', () => {
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
