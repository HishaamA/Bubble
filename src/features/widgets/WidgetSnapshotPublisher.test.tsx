import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WidgetSnapshotPublisher } from './WidgetSnapshotPublisher'
import { BUBBLE_WIDGET_DATA_CHANGED_EVENT } from './widgetStorage'

const mocks = vi.hoisted(() => ({
  privacy: 'full' as 'full' | 'hidden',
  fetchEvents: vi.fn(),
  fetchCapsules: vi.fn(),
  update: vi.fn(async () => true),
  clear: vi.fn(async () => true),
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
  materializeWidgetThumbnail: async () => undefined,
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
})

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
})
