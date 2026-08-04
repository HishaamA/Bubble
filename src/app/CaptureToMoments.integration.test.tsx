import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FamilyMomentSyncProvider,
  SharedMomentsProvider,
  createMemoryMomentStore,
  type MomentChangeNotifier,
  type MomentObjectUrlManager,
} from '../features/memories/shared'
import { CaptureRoute, MemoriesRoute } from './MemoryExperienceRoutes'

vi.mock('../features/capture/equirectangular', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../features/capture/equirectangular')
  >()

  return {
    ...actual,
    readImageDimensions: vi.fn(async () => ({ width: 4000, height: 2000 })),
  }
})

function createSilentNotifier(): MomentChangeNotifier {
  return {
    subscribe: () => () => undefined,
    publish: () => undefined,
    close: () => undefined,
  }
}

describe('capture to Moments integration', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:capture-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  })

  it('renders a shared panorama with its caption above and exactly You below', async () => {
    const user = userEvent.setup()
    const store = createMemoryMomentStore()
    const objectUrls: MomentObjectUrlManager = {
      create: vi.fn(() => 'blob:saved-panorama'),
      revoke: vi.fn(),
    }

    render(
      <SharedMomentsProvider
        store={store}
        objectUrls={objectUrls}
        notifierFactory={createSilentNotifier}
      >
        <FamilyMomentSyncProvider>
          <MemoryRouter initialEntries={['/capture?mode=manual']}>
            <Routes>
              <Route path="/capture" element={<CaptureRoute />} />
              <Route path="/" element={<MemoriesRoute />} />
            </Routes>
          </MemoryRouter>
        </FamilyMomentSyncProvider>
      </SharedMomentsProvider>,
    )

    await user.click(
      screen.getByRole('button', { name: 'Take panoramic photo' }),
    )
    await user.upload(
      screen.getByLabelText('Take a panorama with camera'),
      new File(['panorama pixels'], 'family-garden.jpg', {
        type: 'image/jpeg',
      }),
    )

    expect(
      await screen.findByAltText('Preview of selected 360 panorama'),
    ).toBeInTheDocument()
    await user.type(
      screen.getByRole('textbox', { name: /moment title/i }),
      'Garden with Grandma',
    )
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    expect(
      await screen.findByRole('heading', { name: 'Shared with family' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'View in Memories' }))

    const bubble = await screen.findByRole('button', {
      name: /open garden with grandma shared by you/i,
    })
    expect(
      bubble.querySelector('.memory-bubble__arc-title'),
    ).toHaveTextContent(/^Garden with Grandma$/)
    expect(
      bubble.querySelector('.memory-bubble__arc-sender'),
    ).toHaveTextContent(/^You$/)
    expect(
      bubble.querySelector('.memory-bubble__arc-sender'),
    ).not.toHaveTextContent(/sent by/i)

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        label: 'Garden with Grandma',
        caption: 'Garden with Grandma',
        uploaderDisplayName: 'You',
      }),
    ])
  })
})
