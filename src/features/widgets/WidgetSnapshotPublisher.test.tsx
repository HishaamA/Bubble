import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WidgetSnapshotPublisher } from './WidgetSnapshotPublisher'
import { BUBBLE_WIDGET_DATA_CHANGED_EVENT } from './widgetStorage'
import type { BubbleWidgetSnapshot } from './widgetSnapshot'

const mocks = vi.hoisted(() => ({
  privacy: 'full' as 'full' | 'hidden',
  fetchEvents: vi.fn(),
  fetchCapsules: vi.fn(),
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

afterEach(() => {
  mocks.privacy = 'full'
  vi.clearAllMocks()
  mocks.thumbnail.mockReset().mockResolvedValue(undefined)
})

function familyMemory() {
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7)
  const lastWeek = new Date(monday)
  lastWeek.setDate(lastWeek.getDate() - 7)
  return {
    id: 'last-week', kind: 'weekly', title: 'Last week', familySynced: true,
    opensAt: monday.toISOString(), closesAt: monday.toISOString(),
    createdAt: lastWeek.toISOString(), createdByName: 'Family',
    photos: ['one', 'two'].map((id) => ({
      id, capsuleId: 'last-week', caption: `Memory ${id}`, contributorName: 'Mum',
      capturedAt: lastWeek.toISOString(), syncStatus: 'synced',
      thumbnail: `https://example.test/${id}.jpg`, image: `https://example.test/full-${id}.jpg`,
      width: 800, height: 600, ownedByCurrentUser: false,
    })),
  }
}

async function allowPublish() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
}

describe('WidgetSnapshotPublisher', () => {
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
})
