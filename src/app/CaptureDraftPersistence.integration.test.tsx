import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture360Submission } from '../features/capture'
import { CaptureRoute } from './MemoryExperienceRoutes'

const routeMocks = vi.hoisted(() => ({
  saveMoment: vi.fn(),
  shareMoment: vi.fn(),
}))

vi.mock('../features/capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/capture')>()

  return {
    ...actual,
    Capture360Page: ({
      onSaveDraft,
    }: {
      onSaveDraft?: (submission: Capture360Submission) => void | Promise<void>
    }) => {
      const submission: Capture360Submission = {
        id: 'assembled-sphere-id',
        file: new File(['assembled pixels'], 'assembled-360.jpg', {
          type: 'image/jpeg',
        }),
        caption: '',
        source: 'manual',
        width: 2048,
        height: 1024,
        createdAt: new Date('2026-08-28T12:00:00Z'),
        annotations: [],
      }

      return (
        <button type="button" onClick={() => void onSaveDraft?.(submission)}>
          Finish mock assembly
        </button>
      )
    },
  }
})

vi.mock('../features/memories/shared', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../features/memories/shared')
  >()

  return {
    ...actual,
    useSharedMoments: () => ({
      loading: false,
      error: null,
      moments: [],
      saveMoment: routeMocks.saveMoment,
      refresh: vi.fn(),
    }),
    useFamilyMomentSync: () => ({
      status: 'connected',
      dailyWindow: null,
      error: null,
      shareMoment: routeMocks.shareMoment,
      refreshFamilyMoments: vi.fn(),
    }),
  }
})

describe('CaptureRoute guided draft persistence', () => {
  beforeEach(() => {
    routeMocks.saveMoment.mockReset().mockResolvedValue(undefined)
    routeMocks.shareMoment.mockReset().mockResolvedValue({ delivery: 'family' })
  })

  it('autosaves an assembled sphere to the local moment store without publishing it', async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/capture?mode=manual']}>
        <Routes>
          <Route path="/capture" element={<CaptureRoute />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Finish mock assembly' }))

    await waitFor(() => expect(routeMocks.saveMoment).toHaveBeenCalledTimes(1))
    expect(routeMocks.saveMoment).toHaveBeenCalledWith(expect.objectContaining({
      id: 'assembled-sphere-id',
      blob: expect.any(File),
      caption: '',
      source: 'manual',
      width: 2048,
      height: 1024,
      uploaderDisplayName: 'You',
      annotations: [],
      isDraft: true,
    }))
    expect(routeMocks.shareMoment).not.toHaveBeenCalled()
  })
})
