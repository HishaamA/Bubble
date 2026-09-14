import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Capture360Page } from './Capture360Page'
import {
  AiPanoramaError,
  assembleAiNativePanorama,
  assembleAiPhotoPanorama,
  checkAiPanoramaHealth,
} from '../../services/media/aiPanorama'
import { composeGuidedPanorama } from '../../services/media/composeGuidedPanorama'

vi.mock('../../services/media/aiPanorama', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/media/aiPanorama')>(),
  checkAiPanoramaHealth: vi.fn(),
  assembleAiNativePanorama: vi.fn(),
  assembleAiPhotoPanorama: vi.fn(),
}))
vi.mock('../../services/media/composeGuidedPanorama', () => ({ composeGuidedPanorama: vi.fn() }))
vi.mock('./GuidedPanoramaReview', () => ({ GuidedPanoramaReview: () => <h2>Review your 360°</h2> }))

const result = {
  viewer: new Blob(['sphere'], { type: 'image/jpeg' }), thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
  viewerWidth: 4096, viewerHeight: 2048, thumbnailWidth: 640, thumbnailHeight: 320,
  report: { warnings: ['Check the floor joins.'] },
}
const capture = {
  targetCount: 34, capturedCount: 34, directoryUrl: 'file:///captures/session',
  frames: Array.from({ length: 34 }, (_, index) => ({ width: 1920, height: 1440, uri: `file:///captures/${index}.jpg` })),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkAiPanoramaHealth).mockResolvedValue({ status: 'ok', aiAvailable: true, device: 'cuda', model: 'DISK + LightGlue' })
  vi.mocked(assembleAiNativePanorama).mockResolvedValue(result)
  vi.mocked(assembleAiPhotoPanorama).mockResolvedValue(result)
  vi.mocked(composeGuidedPanorama).mockResolvedValue(result)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:ai-sphere') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

describe('AI assembly capture integration', () => {
  it('uses original native photos and keeps them after the assembled sphere saves', async () => {
    let resolveSave!: () => void
    const onSaveDraft = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve }))
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(capture)} discardGuidedCapture={discardGuidedCapture} onSaveDraft={onSaveDraft} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(assembleAiNativePanorama).toHaveBeenCalledWith(capture, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(screen.getByText(/check the floor joins/i)).toBeInTheDocument()
    expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({ width: 4096, height: 2048 }))
    expect(discardGuidedCapture).not.toHaveBeenCalled()
    await act(async () => resolveSave())
    expect(discardGuidedCapture).not.toHaveBeenCalled()
  })

  it('retains a quality-rejected capture for retry without silently saving the rough compositor', async () => {
    vi.mocked(assembleAiNativePanorama).mockRejectedValueOnce(new AiPanoramaError('Too much movement between photos.', 'quality_rejected')).mockResolvedValue(result)
    const startGuidedCapture = vi.fn().mockResolvedValue(capture)
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    const onSaveDraft = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" initialMode="manual" guidedCaptureAvailable startGuidedCapture={startGuidedCapture} discardGuidedCapture={discardGuidedCapture} onSaveDraft={onSaveDraft} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too much movement')
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(onSaveDraft).not.toHaveBeenCalled()
    expect(discardGuidedCapture).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Retry enhanced assembly' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(startGuidedCapture).toHaveBeenCalledTimes(1)
    expect(assembleAiNativePanorama).toHaveBeenCalledTimes(2)
  })

  it('keeps original photos after a network failure without a rough fallback', async () => {
    vi.mocked(assembleAiNativePanorama).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<Capture360Page assemblyMode="advanced" initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(capture)} discardGuidedCapture={vi.fn().mockResolvedValue(undefined)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch')
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry enhanced assembly' })).toBeEnabled()
  })

  it('does not delete originals when a pending save rejects after navigation', async () => {
    let rejectSave!: (error: Error) => void
    const onSaveDraft = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSave = reject }))
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    const first = render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:delayed-save" initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(capture)} discardGuidedCapture={discardGuidedCapture} onSaveDraft={onSaveDraft} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1))
    first.unmount()
    await act(async () => rejectSave(new Error('Storage failed after navigation')))
    expect(discardGuidedCapture).not.toHaveBeenCalled()

    const startAgain = vi.fn()
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:delayed-save" initialMode="manual" guidedCaptureAvailable startGuidedCapture={startAgain} discardGuidedCapture={discardGuidedCapture} onSaveDraft={vi.fn().mockResolvedValue(undefined)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry enhanced assembly' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(startAgain).not.toHaveBeenCalled()
    expect(discardGuidedCapture).not.toHaveBeenCalled()
  })

  it('restores a rejected capture on remount only for its original signed-in identity', async () => {
    vi.mocked(assembleAiNativePanorama).mockRejectedValueOnce(new AiPanoramaError('Too much movement.', 'quality_rejected')).mockResolvedValue(result)
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    const first = render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:owner-a" initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(capture)} discardGuidedCapture={discardGuidedCapture} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    await screen.findByRole('alert')
    first.unmount()

    const otherAccount = render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:owner-b" initialMode="manual" guidedCaptureAvailable />)
    expect(screen.queryByRole('button', { name: 'Retry enhanced assembly' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start guided 360 capture' })).toBeInTheDocument()
    otherAccount.unmount()

    const startAgain = vi.fn()
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:owner-a" initialMode="manual" guidedCaptureAvailable startGuidedCapture={startAgain} discardGuidedCapture={discardGuidedCapture} onSaveDraft={vi.fn().mockResolvedValue(undefined)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry enhanced assembly' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(startAgain).not.toHaveBeenCalled()
    expect(discardGuidedCapture).not.toHaveBeenCalled()
  })

  it('retains a complete native capture that returns after the route unmounts', async () => {
    let finishCapture!: (value: typeof capture) => void
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    const first = render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:late-native" initialMode="manual" guidedCaptureAvailable startGuidedCapture={() => new Promise((resolve) => { finishCapture = resolve })} discardGuidedCapture={discardGuidedCapture} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    first.unmount()
    await act(async () => finishCapture(capture))
    expect(discardGuidedCapture).not.toHaveBeenCalled()
    const startAgain = vi.fn()
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:late-native" initialMode="manual" guidedCaptureAvailable startGuidedCapture={startAgain} discardGuidedCapture={discardGuidedCapture} onSaveDraft={vi.fn().mockResolvedValue(undefined)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry enhanced assembly' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(startAgain).not.toHaveBeenCalled()
    expect(discardGuidedCapture).not.toHaveBeenCalled()
  })

  it('allows explicitly discarding a rejected source set before a fresh capture', async () => {
    vi.mocked(assembleAiNativePanorama).mockRejectedValueOnce(new AiPanoramaError('Missing coverage.', 'quality_rejected'))
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey="clerk:discard-rejected" initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(capture)} discardGuidedCapture={discardGuidedCapture} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    await screen.findByRole('alert')
    expect(discardGuidedCapture).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove originals' }))
    expect(discardGuidedCapture).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Permanently remove originals' }))
    await waitFor(() => expect(discardGuidedCapture).toHaveBeenCalledWith(capture))
    expect(screen.getByRole('button', { name: 'Start guided 360 capture' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Retry enhanced assembly' })).not.toBeInTheDocument()
  })

  it('lets browser users assemble overlapping originals and autosaves the result', async () => {
    const onSaveDraft = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" initialMode="manual" guidedCaptureAvailable={false} onSaveDraft={onSaveDraft} />)
    const files = Array.from({ length: 8 }, (_, index) => new File(['photo'], `${index}.jpg`, { type: 'image/jpeg' }))
    fireEvent.change(screen.getByLabelText('Choose overlapping source photos for AI assembly'), { target: { files } })
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(assembleAiPhotoPanorama).toHaveBeenCalledWith(files, expect.any(Object))
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({ width: 4096, source: 'manual' })))
  })
})
