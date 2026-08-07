import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FamilyMomentSyncProvider } from './FamilyMomentSyncProvider'
import { SharedMomentsProvider } from './SharedMomentsProvider'
import { createMemoryMomentStore } from './store'
import type {
  MomentChangeNotifier,
  StoredPanoramaAnnotation,
} from './types'
import { useFamilyMomentSync } from './useFamilyMomentSync'
import { useSharedMoments } from './useSharedMoments'

const familyService = vi.hoisted(() => ({
  fetchFamilyMoments: vi.fn(),
  getFamilyDailyCaptureWindow: vi.fn(),
  getFamilyMomentConnection: vi.fn(),
  publishFamilyMoment: vi.fn(),
  subscribeToFamilyMoments: vi.fn(),
}))

vi.mock('../../../services/media/familyMomentService', () => familyService)

const voiceBlob = new Blob(['voice'], { type: 'audio/mp4' })
const annotations: StoredPanoramaAnnotation[] = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    kind: 'text',
    pitch: 8,
    yaw: -15,
    message: 'The family table',
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    kind: 'voice',
    pitch: -3,
    yaw: 22,
    message: 'A hello from Mum',
    audioBlob: voiceBlob,
    audioMimeType: 'audio/mp4',
    durationMs: 2_500,
  },
]

function createSilentNotifier(): MomentChangeNotifier {
  return {
    subscribe: () => () => undefined,
    publish: () => undefined,
    close: () => undefined,
  }
}

function SyncHarness() {
  const { moments } = useSharedMoments()
  const { status, shareMoment } = useFamilyMomentSync()

  return (
    <div>
      <p>Sync: {status}</p>
      <p>{moments.length} shared moments</p>
      <button
        type="button"
        onClick={() =>
          void shareMoment({
            id: 'local-360',
            file: new File(['panorama'], 'family.jpg', {
              type: 'image/jpeg',
            }),
            caption: 'Family balcony',
            source: 'manual',
            width: 4000,
            height: 2000,
            createdAt: new Date('2026-08-26T10:00:00.000Z'),
            annotations,
          })
        }
      >
        Share moment
      </button>
    </div>
  )
}

describe('FamilyMomentSyncProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    familyService.getFamilyMomentConnection.mockResolvedValue(null)
    familyService.getFamilyDailyCaptureWindow.mockResolvedValue(null)
    familyService.fetchFamilyMoments.mockResolvedValue([])
    familyService.subscribeToFamilyMoments.mockReturnValue({
      ready: Promise.resolve(),
      unsubscribe: vi.fn(),
    })
  })

  it('falls back to the local memory path when no family backend is configured', async () => {
    const user = userEvent.setup()
    const store = createMemoryMomentStore()

    render(
      <SharedMomentsProvider
        store={store}
        notifierFactory={createSilentNotifier}
      >
        <FamilyMomentSyncProvider>
          <SyncHarness />
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>,
    )

    expect(await screen.findByText('Sync: local')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share moment' }))
    await waitFor(() =>
      expect(screen.getByText('1 shared moments')).toBeInTheDocument(),
    )
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'local-360',
        label: 'Family balcony',
        source: 'manual',
        uploaderDisplayName: 'You',
        annotations,
      }),
    ])
  })

  it('keeps annotations in the local cache after a connected family publish', async () => {
    const user = userEvent.setup()
    const store = createMemoryMomentStore()
    const viewer = new Blob(['processed panorama'], { type: 'image/jpeg' })
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.publishFamilyMoment.mockResolvedValue({
      viewer,
      thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
      viewerWidth: 4096,
      viewerHeight: 2048,
      thumbnailWidth: 800,
      thumbnailHeight: 400,
    })

    render(
      <SharedMomentsProvider
        store={store}
        notifierFactory={createSilentNotifier}
      >
        <FamilyMomentSyncProvider>
          <SyncHarness />
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>,
    )

    expect(await screen.findByText('Sync: connected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share moment' }))
    await waitFor(() =>
      expect(screen.getByText('1 shared moments')).toBeInTheDocument(),
    )

    expect(familyService.publishFamilyMoment).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ annotations }),
    )
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'local-360',
        blob: viewer,
        annotations,
      }),
    ])
  })

  it('waits for realtime to subscribe before its initial family fetch', async () => {
    const store = createMemoryMomentStore()
    let markRealtimeReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      markRealtimeReady = resolve
    })
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.subscribeToFamilyMoments.mockReturnValue({
      ready,
      unsubscribe: vi.fn(),
    })

    render(
      <SharedMomentsProvider
        store={store}
        notifierFactory={createSilentNotifier}
      >
        <FamilyMomentSyncProvider>
          <SyncHarness />
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>,
    )

    await waitFor(() =>
      expect(familyService.subscribeToFamilyMoments).toHaveBeenCalledOnce(),
    )
    expect(familyService.fetchFamilyMoments).not.toHaveBeenCalled()

    markRealtimeReady()

    await waitFor(() =>
      expect(familyService.fetchFamilyMoments).toHaveBeenCalledOnce(),
    )
    expect(await screen.findByText('Sync: connected')).toBeInTheDocument()
  })
})
