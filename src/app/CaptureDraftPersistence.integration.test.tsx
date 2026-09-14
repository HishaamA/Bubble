import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, type AuthContextValue } from '../features/auth'
import type { Capture360Submission } from '../features/capture'
import { CaptureRoute } from './MemoryExperienceRoutes'

const captureAuth: AuthContextValue = {
  status: 'signed-in',
  user: {
    id: 'capture-route-test-user',
    displayName: 'You',
    email: null,
    phone: null,
    imageUrl: null,
  },
  getToken: async () => null,
  signOut: async () => undefined,
}

const routeMocks = vi.hoisted(() => ({
  saveMoment: vi.fn(),
  shareMoment: vi.fn(),
}))

vi.mock('../features/capture/Generative360Page', () => ({
  Generative360Page: ({ onSave, captureOwnerKey }: {
    onSave: (submission: Capture360Submission) => Promise<void>; captureOwnerKey: string
  }) => <button type="button" data-capture-owner={captureOwnerKey} onClick={() => void onSave({
    id: 'generated-scene-id', file: new File(['generated sphere'], 'scene.jpg', { type: 'image/jpeg' }),
    caption: 'AI reconstruction. Includes imagined details.', source: 'manual', width: 2048, height: 1024,
    createdAt: new Date('2026-09-09T12:00:00Z'), annotations: [],
    provenance: { kind: 'ai-reconstruction', provider: 'local', model: 'local-model', referenceCount: 2, generatedAt: '2026-09-09T12:01:00Z' },
  })}>Save mock AI scene</button>,
}))

vi.mock('../features/capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/capture')>()

  return {
    ...actual,
    Capture360Page: ({
      onSaveDraft,
      captureOwnerKey,
      assemblyMode,
    }: {
      onSaveDraft?: (submission: Capture360Submission) => void | Promise<void>
      captureOwnerKey?: string
      assemblyMode?: string
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
        captureSessionId: 'retained-native-session',
      }

      return (
        <button
          type="button"
          data-capture-owner={captureOwnerKey}
          data-assembly-mode={assemblyMode}
          onClick={() => void onSaveDraft?.(submission)}
        >
          Finish mock assembly
        </button>
      )
    },
  }
})

function renderCaptureRoute(auth = captureAuth, entry = '/capture?workflow=legacy&mode=manual') {
  return render(
    <AuthProvider value={auth}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/capture" element={<CaptureRoute />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

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

    renderCaptureRoute()

    expect(
      screen.getByRole('button', { name: 'Finish mock assembly' }),
    ).toHaveAttribute('data-capture-owner', 'clerk:capture-route-test-user')

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
      captureSessionId: 'retained-native-session',
    }))
    expect(routeMocks.shareMoment).not.toHaveBeenCalled()
  })

  it('keeps the development preview capture namespace separate from Clerk', () => {
    renderCaptureRoute({ ...captureAuth, isDevelopmentPreview: true })

    expect(
      screen.getByRole('button', { name: 'Finish mock assembly' }),
    ).toHaveAttribute('data-capture-owner', 'demo:capture-route-test-user')
  })

  it('uses the shared on-device compositor by default without requiring an AI computer', () => {
    renderCaptureRoute(captureAuth, '/capture?mode=manual')
    expect(screen.getByRole('button', { name: 'Finish mock assembly' })).toHaveAttribute('data-assembly-mode', 'standard')
    expect(screen.queryByRole('button', { name: 'Save mock AI scene' })).not.toBeInTheDocument()
  })

  it('only opts into strict assembly on the explicit advanced route', () => {
    renderCaptureRoute(captureAuth, '/capture?workflow=advanced')
    expect(screen.getByRole('button', { name: 'Finish mock assembly' })).toHaveAttribute('data-assembly-mode', 'advanced')
  })

  it('keeps optional AI scenes accessible and explicitly saves provenance locally without family publishing', async () => {
    renderCaptureRoute(captureAuth, '/capture?workflow=ai')
    expect(screen.queryByRole('button', { name: 'Finish mock assembly' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save mock AI scene' })).toHaveAttribute('data-capture-owner', 'clerk:capture-route-test-user')
    await userEvent.click(screen.getByRole('button', { name: 'Save mock AI scene' }))
    expect(routeMocks.saveMoment).toHaveBeenCalledWith(expect.objectContaining({
      id: 'generated-scene-id', source: 'manual', familySynced: false,
      provenance: expect.objectContaining({ kind: 'ai-reconstruction', provider: 'local', referenceCount: 2 }),
    }))
    expect(routeMocks.shareMoment).not.toHaveBeenCalled()
  })
})
