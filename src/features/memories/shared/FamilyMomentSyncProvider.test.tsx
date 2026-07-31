import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { FamilyMomentSyncProvider } from './FamilyMomentSyncProvider'
import { SharedMomentsProvider } from './SharedMomentsProvider'
import { createMemoryMomentStore } from './store'
import type { MomentChangeNotifier } from './types'
import { useFamilyMomentSync } from './useFamilyMomentSync'
import { useSharedMoments } from './useSharedMoments'

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
          })
        }
      >
        Share locally
      </button>
    </div>
  )
}

describe('FamilyMomentSyncProvider', () => {
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
    await user.click(screen.getByRole('button', { name: 'Share locally' }))
    await waitFor(() =>
      expect(screen.getByText('1 shared moments')).toBeInTheDocument(),
    )
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'local-360',
        label: 'Family balcony',
        source: 'manual',
        uploaderDisplayName: 'You',
      }),
    ])
  })
})
