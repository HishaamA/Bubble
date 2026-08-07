import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  SharedMomentsProvider,
} from './SharedMomentsProvider'
import {
  createMemoryMomentStore,
  createResilientMomentStore,
  momentDatabaseNameForSubject,
} from './store'
import type {
  MomentChangeNotifier,
  MomentObjectUrlManager,
  MomentStore,
  StoredPanoramaMoment,
} from './types'
import { useSharedMoments } from './useSharedMoments'

const firstMoment: StoredPanoramaMoment = {
  id: 'first-panorama',
  blob: new Blob(['first'], { type: 'image/jpeg' }),
  label: 'Friday picnic',
  caption: 'Everyone made it before sunset.',
  createdAt: '2026-08-25T17:00:00.000Z',
  width: 4096,
  height: 2048,
  source: 'daily',
  uploaderDisplayName: 'Maya',
  annotations: [],
}

function createSilentNotifier(): MomentChangeNotifier {
  return {
    subscribe: () => () => undefined,
    publish: () => undefined,
    close: () => undefined,
  }
}

function MomentHarness() {
  const { loading, moments, saveMoment } = useSharedMoments()

  return (
    <div>
      <p>{loading ? 'Loading moments' : `${moments.length} moments`}</p>
      <ul>
        {moments.map((moment) => (
          <li key={moment.id}>
            {moment.label} — {moment.objectUrl ?? 'No preview'}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() =>
          void saveMoment({
            id: 'new-panorama',
            blob: new Blob(['new'], { type: 'image/jpeg' }),
            label: 'Kitchen surprise',
            caption: 'A daily family check-in.',
            createdAt: '2026-08-26T10:15:00.000Z',
            width: 6000,
            height: 3000,
            source: 'manual',
            uploaderDisplayName: 'Omar',
          })
        }
      >
        Save panorama
      </button>
    </div>
  )
}

describe('SharedMomentsProvider', () => {
  it('uses a separate IndexedDB namespace for each authenticated subject', () => {
    expect(momentDatabaseNameForSubject('user_alice')).not.toBe(
      momentDatabaseNameForSubject('user_bob'),
    )
    expect(momentDatabaseNameForSubject('user/alice')).toContain('user%2Falice')
  })

  it('loads stored panoramas and exposes local object URLs', async () => {
    const objectUrls: MomentObjectUrlManager = {
      create: vi.fn(() => 'blob:local-preview'),
      revoke: vi.fn(),
    }

    render(
      <SharedMomentsProvider
        store={createMemoryMomentStore([firstMoment])}
        objectUrls={objectUrls}
        notifierFactory={createSilentNotifier}
      >
        <MomentHarness />
      </SharedMomentsProvider>,
    )

    expect(await screen.findByText('1 moments')).toBeInTheDocument()
    expect(
      screen.getByText('Friday picnic — blob:local-preview'),
    ).toBeInTheDocument()
    expect(objectUrls.create).toHaveBeenCalledWith(firstMoment.blob)
  })

  it('saves a panorama, refreshes the list, and revokes replaced URLs', async () => {
    const user = userEvent.setup()
    const store = createMemoryMomentStore([firstMoment])
    let objectUrlNumber = 0
    const objectUrls: MomentObjectUrlManager = {
      create: vi.fn(() => `blob:preview-${++objectUrlNumber}`),
      revoke: vi.fn(),
    }

    const view = render(
      <SharedMomentsProvider
        store={store}
        objectUrls={objectUrls}
        notifierFactory={createSilentNotifier}
      >
        <MomentHarness />
      </SharedMomentsProvider>,
    )

    expect(await screen.findByText('1 moments')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save panorama' }))

    expect(await screen.findByText('2 moments')).toBeInTheDocument()
    expect(screen.getByText(/Kitchen surprise/)).toBeInTheDocument()
    expect((await store.list())[0]).toMatchObject({
      id: 'new-panorama',
      source: 'manual',
      uploaderDisplayName: 'Omar',
      width: 6000,
      height: 3000,
    })
    expect(objectUrls.revoke).toHaveBeenCalledWith('blob:preview-1')

    view.unmount()
    expect(objectUrls.revoke).toHaveBeenCalledWith('blob:preview-2')
    expect(objectUrls.revoke).toHaveBeenCalledWith('blob:preview-3')
  })

  it('falls back to memory when persistent storage is unavailable', async () => {
    const unavailableStore: MomentStore = {
      list: vi.fn(async () => {
        throw new Error('IndexedDB denied')
      }),
      save: vi.fn(async () => {
        throw new Error('IndexedDB denied')
      }),
    }
    const fallback = createMemoryMomentStore()
    const store = createResilientMomentStore(unavailableStore, fallback)

    await expect(store.list()).resolves.toEqual([])
    await store.save(firstMoment)
    await expect(store.list()).resolves.toEqual([firstMoment])
    expect(unavailableStore.save).not.toHaveBeenCalled()
  })
})
