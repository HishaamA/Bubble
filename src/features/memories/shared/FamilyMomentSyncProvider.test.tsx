import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FamilyMomentSyncProvider } from './FamilyMomentSyncProvider'
import { SharedMomentsProvider } from './SharedMomentsProvider'
import { createMemoryMomentStore } from './store'
import type {
  MomentChangeNotifier,
  StoredPanoramaAnnotation,
  StoredPanoramaMoment,
} from './types'
import { useFamilyMomentSync } from './useFamilyMomentSync'
import { useSharedMoments } from './useSharedMoments'

const familyService = vi.hoisted(() => ({
  deleteFamilyMoment: vi.fn(),
  fetchFamilyMomentDeletionIds: vi.fn(),
  fetchFamilyMoments: vi.fn(),
  getFamilyDailyCaptureWindow: vi.fn(),
  getFamilyMomentConnection: vi.fn(),
  publishFamilyMoment: vi.fn(),
  replaceFamilyMomentAnnotations: vi.fn(),
  resumePendingFamilyMomentDeletions: vi.fn(),
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

const syncedOwnedMoment: StoredPanoramaMoment = {
  id: '40000000-0000-4000-8000-000000000001',
  blob: new Blob(['family panorama'], { type: 'image/jpeg' }),
  label: 'Sunday dinner',
  caption: 'Sunday dinner',
  createdAt: '2026-08-28T12:00:00.000Z',
  width: 4096,
  height: 2048,
  source: 'manual',
  uploaderDisplayName: 'You',
  ownedByCurrentUser: true,
  familySynced: true,
  annotations: [],
}

function createSilentNotifier(): MomentChangeNotifier {
  return {
    subscribe: () => () => undefined,
    publish: () => undefined,
    close: () => undefined,
  }
}

function SyncHarness() {
  const { moments } = useSharedMoments()
  const {
    deleteMoment,
    shareMoment,
    status,
    updateMomentAnnotations,
  } = useFamilyMomentSync()

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
      {moments[0] ? (
        <>
          <button
            type="button"
            onClick={() => void updateMomentAnnotations(moments[0].id, annotations)}
          >
            Update first points
          </button>
          <button type="button" onClick={() => void deleteMoment(moments[0].id)}>
            Remove first moment
          </button>
        </>
      ) : null}
    </div>
  )
}

describe('FamilyMomentSyncProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    familyService.getFamilyMomentConnection.mockResolvedValue(null)
    familyService.getFamilyDailyCaptureWindow.mockResolvedValue(null)
    familyService.fetchFamilyMoments.mockResolvedValue([])
    familyService.fetchFamilyMomentDeletionIds.mockResolvedValue([])
    familyService.deleteFamilyMoment.mockResolvedValue({ cleanupPending: false })
    familyService.replaceFamilyMomentAnnotations.mockResolvedValue(undefined)
    familyService.resumePendingFamilyMomentDeletions.mockResolvedValue(undefined)
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

  it('migrates and removes a legacy device-local moment created by this phone', async () => {
    const user = userEvent.setup()
    const legacyLocalMoment: StoredPanoramaMoment = {
      id: 'legacy-local-360',
      blob: new Blob(['legacy panorama'], { type: 'image/jpeg' }),
      label: "Someone's house",
      caption: "Someone's house",
      createdAt: '2026-08-28T19:00:00.000Z',
      width: 4096,
      height: 2048,
      source: 'manual',
      uploaderDisplayName: 'You',
      annotations: [],
    }
    const store = createMemoryMomentStore([legacyLocalMoment])

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
    await waitFor(async () => {
      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({
          id: legacyLocalMoment.id,
          ownedByCurrentUser: true,
          familySynced: false,
        }),
      ])
    })

    await user.click(
      screen.getByRole('button', { name: 'Remove first moment' }),
    )
    await waitFor(() =>
      expect(screen.getByText('0 shared moments')).toBeInTheDocument(),
    )
    expect(familyService.deleteFamilyMoment).not.toHaveBeenCalled()
    await expect(store.list()).resolves.toEqual([])
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

  it('does not subscribe a stale connection after deletion recovery finishes', async () => {
    let finishFirstRecovery: () => void = () => undefined
    const firstRecovery = new Promise<void>((resolve) => {
      finishFirstRecovery = resolve
    })
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.resumePendingFamilyMomentDeletions
      .mockReturnValueOnce(firstRecovery)
      .mockResolvedValue(undefined)

    render(
      <SharedMomentsProvider
        store={createMemoryMomentStore()}
        notifierFactory={createSilentNotifier}
      >
        <FamilyMomentSyncProvider>
          <SyncHarness />
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>,
    )

    await waitFor(() =>
      expect(
        familyService.resumePendingFamilyMomentDeletions,
      ).toHaveBeenCalledTimes(1),
    )
    window.dispatchEvent(new Event('focus'))

    await waitFor(() =>
      expect(
        familyService.resumePendingFamilyMomentDeletions,
      ).toHaveBeenCalledTimes(2),
    )
    await waitFor(() =>
      expect(familyService.subscribeToFamilyMoments).toHaveBeenCalledOnce(),
    )

    await act(async () => {
      finishFirstRecovery()
      await firstRecovery
    })

    expect(familyService.subscribeToFamilyMoments).toHaveBeenCalledOnce()
  })

  it('does not subscribe after unmount while deletion recovery is pending', async () => {
    let finishRecovery: () => void = () => undefined
    const recovery = new Promise<void>((resolve) => {
      finishRecovery = resolve
    })
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.resumePendingFamilyMomentDeletions.mockReturnValue(recovery)

    const { unmount } = render(
      <SharedMomentsProvider
        store={createMemoryMomentStore()}
        notifierFactory={createSilentNotifier}
      >
        <FamilyMomentSyncProvider>
          <SyncHarness />
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>,
    )

    await waitFor(() =>
      expect(
        familyService.resumePendingFamilyMomentDeletions,
      ).toHaveBeenCalledOnce(),
    )
    unmount()

    await act(async () => {
      finishRecovery()
      await recovery
    })

    expect(familyService.subscribeToFamilyMoments).not.toHaveBeenCalled()
  })

  it('deletes an owned synced moment through the backend before evicting its local cache', async () => {
    const user = userEvent.setup()
    const store = createMemoryMomentStore([syncedOwnedMoment])
    const connection = {
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    }
    familyService.getFamilyMomentConnection.mockResolvedValue(connection)
    familyService.fetchFamilyMoments.mockResolvedValue([
      {
        ...syncedOwnedMoment,
        ownedByCurrentUser: true,
        familySynced: true,
      },
    ])

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
    await user.click(
      screen.getByRole('button', { name: 'Remove first moment' }),
    )
    await waitFor(() =>
      expect(screen.getByText('0 shared moments')).toBeInTheDocument(),
    )
    expect(familyService.deleteFamilyMoment).toHaveBeenCalledWith(
      connection,
      syncedOwnedMoment.id,
    )
    await expect(store.list()).resolves.toEqual([])
  })

  it('does not evict valid cached moments merely because the server page is capped', async () => {
    const store = createMemoryMomentStore([
      { ...syncedOwnedMoment, ownedByCurrentUser: false, uploaderDisplayName: 'Maya' },
    ])
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.fetchFamilyMoments.mockResolvedValue([])

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
    await waitFor(() => expect(familyService.fetchFamilyMoments).toHaveBeenCalled())
    expect(screen.getByText('1 shared moments')).toBeInTheDocument()
    await expect(store.list()).resolves.toHaveLength(1)
  })

  it('replaces a synced owner’s annotations remotely before updating its durable cache', async () => {
    const user = userEvent.setup()
    const store = createMemoryMomentStore([syncedOwnedMoment])
    const connection = {
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    }
    familyService.getFamilyMomentConnection.mockResolvedValue(connection)
    familyService.fetchFamilyMoments.mockResolvedValue([syncedOwnedMoment])

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
    await user.click(screen.getByRole('button', { name: 'Update first points' }))

    await waitFor(() =>
      expect(familyService.replaceFamilyMomentAnnotations).toHaveBeenCalledWith(
        connection,
        syncedOwnedMoment.id,
        annotations,
      ),
    )
    await waitFor(async () => {
      const [saved] = await store.list()
      expect(saved?.annotations).toEqual(annotations)
    })
  })

  it('updates a locally owned sphere without requiring family connectivity', async () => {
    const user = userEvent.setup()
    const localMoment: StoredPanoramaMoment = {
      ...syncedOwnedMoment,
      id: '40000000-0000-4000-8000-000000000099',
      familySynced: false,
    }
    const store = createMemoryMomentStore([localMoment])

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
    await user.click(screen.getByRole('button', { name: 'Update first points' }))

    await waitFor(async () => {
      const [saved] = await store.list()
      expect(saved?.annotations).toEqual(annotations)
    })
    expect(familyService.replaceFamilyMomentAnnotations).not.toHaveBeenCalled()
  })

  it('retries an incomplete cached voice-note download on refresh', async () => {
    const voiceAnnotationWithoutAudio: StoredPanoramaAnnotation = {
      id: '50000000-0000-4000-8000-000000000099',
      kind: 'voice',
      pitch: 4,
      yaw: 18,
      message: 'Dad telling the birthday story',
      audioMimeType: 'audio/mp4',
      durationMs: 3_200,
    }
    const cachedMoment: StoredPanoramaMoment = {
      ...syncedOwnedMoment,
      annotations: [voiceAnnotationWithoutAudio],
    }
    const downloadedVoice = new Blob(['recovered voice'], {
      type: 'audio/mp4',
    })
    const store = createMemoryMomentStore([cachedMoment])
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.fetchFamilyMoments.mockResolvedValue([
      {
        ...cachedMoment,
        annotations: [
          { ...voiceAnnotationWithoutAudio, audioBlob: downloadedVoice },
        ],
      },
    ])

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
    await waitFor(async () => {
      const [saved] = await store.list()
      expect(saved?.annotations?.[0]?.audioBlob).toBe(downloadedVoice)
    })
  })

  it('preserves good cached voice audio during a transient remote download failure', async () => {
    const cachedVoice = new Blob(['known-good voice'], { type: 'audio/mp4' })
    const voiceAnnotation: StoredPanoramaAnnotation = {
      id: '50000000-0000-4000-8000-000000000098',
      kind: 'voice',
      pitch: -7,
      yaw: 33,
      message: 'Mum describing the old family clock',
      audioBlob: cachedVoice,
      audioMimeType: 'audio/mp4',
      durationMs: 4_100,
    }
    const cachedMoment: StoredPanoramaMoment = {
      ...syncedOwnedMoment,
      annotations: [voiceAnnotation],
    }
    const store = createMemoryMomentStore([cachedMoment])
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.fetchFamilyMoments.mockResolvedValue([
      {
        ...cachedMoment,
        annotations: [
          {
            id: voiceAnnotation.id,
            kind: 'voice',
            pitch: voiceAnnotation.pitch,
            yaw: voiceAnnotation.yaw,
            message: voiceAnnotation.message,
          },
        ],
      },
    ])

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
    await waitFor(() => expect(familyService.fetchFamilyMoments).toHaveBeenCalled())
    const [saved] = await store.list()
    expect(saved?.annotations?.[0]?.audioBlob).toBe(cachedVoice)
    expect(saved?.annotations?.[0]?.audioMimeType).toBe('audio/mp4')
  })

  it('evicts a tombstoned cache immediately and prevents an in-flight fetch from resurrecting it', async () => {
    let resolveFetch: (moments: unknown[]) => void = () => undefined
    const fetch = new Promise<unknown[]>((resolve) => {
      resolveFetch = resolve
    })
    familyService.getFamilyMomentConnection.mockResolvedValue({
      circleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '10000000-0000-4000-8000-000000000001',
    })
    familyService.fetchFamilyMoments.mockReturnValue(fetch)
    familyService.fetchFamilyMomentDeletionIds.mockResolvedValue([
      syncedOwnedMoment.id,
    ])
    const store = createMemoryMomentStore([syncedOwnedMoment])

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
      expect(familyService.fetchFamilyMoments).toHaveBeenCalledOnce(),
    )
    const realtimeCallback = familyService.subscribeToFamilyMoments.mock
      .calls[0][1] as (deletedMomentId?: string) => void
    realtimeCallback(syncedOwnedMoment.id)
    resolveFetch([{ ...syncedOwnedMoment }])

    await waitFor(() =>
      expect(screen.getByText('0 shared moments')).toBeInTheDocument(),
    )
    await expect(store.list()).resolves.toEqual([])
  })
})
