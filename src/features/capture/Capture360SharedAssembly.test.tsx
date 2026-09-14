import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Capture360Page } from './Capture360Page'
import { composeGuidedPanorama } from '../../services/media/composeGuidedPanorama'
import { assembleAiNativePanorama, checkAiPanoramaHealth } from '../../services/media/aiPanorama'
import { assembleNativePanorama, getNativePanoramaStitchStatus, getSavedNativeCaptures, openSavedNativePanorama } from '../../services/media/nativePanoramaStitch'

const platform = vi.hoisted(() => ({ android: true }))
vi.mock('../../services/media/nativePanoramaStitch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/media/nativePanoramaStitch')>(),
  usesNativePanoramaStitch: () => platform.android,
  getNativePanoramaStitchStatus: vi.fn(), getSavedNativeCaptures: vi.fn(),
  assembleNativePanorama: vi.fn(), openSavedNativePanorama: vi.fn(),
}))
vi.mock('../../services/media/aiPanorama', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/media/aiPanorama')>(),
  checkAiPanoramaHealth: vi.fn(), assembleAiNativePanorama: vi.fn(),
}))
vi.mock('../../services/media/composeGuidedPanorama', () => ({ composeGuidedPanorama: vi.fn() }))
vi.mock('./GuidedPanoramaReview', () => ({ GuidedPanoramaReview: () => <h2>Review your 360°</h2> }))

const processed = { viewer: new Blob(['sphere'], { type: 'image/jpeg' }),
  thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }), viewerWidth: 2048, viewerHeight: 1024,
  thumbnailWidth: 640, thumbnailHeight: 320 }
function capture(ownerKey: string, sessionId = `session-${ownerKey}`) {
  return { ownerKey, sessionId, directoryUrl: `file:///captures/${sessionId}`, targetCount: 34, capturedCount: 34,
    frames: Array.from({ length: 34 }, (_, index) => ({ uri: `file:///captures/${sessionId}/${index}.jpg`, width: 1080, height: 1920 })) }
}
async function start() {
  const button = await screen.findByRole('button', { name: 'Start guided 360 capture' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.android = true
  vi.mocked(getNativePanoramaStitchStatus).mockReset().mockResolvedValue({ available: false, offline: true, model: 'Unavailable' })
  vi.mocked(getSavedNativeCaptures).mockReset().mockResolvedValue([])
  vi.mocked(assembleNativePanorama).mockReset().mockResolvedValue(processed)
  vi.mocked(openSavedNativePanorama).mockReset().mockResolvedValue(processed)
  vi.mocked(composeGuidedPanorama).mockReset().mockResolvedValue(processed)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:shared-sphere') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

describe('standard shared phone assembly', () => {
  it('uses the exact shared compositor at2K without model or computer health and retains originals', async () => {
    const owner = 'clerk:shared-default'
    const original = capture(owner)
    const save = vi.fn().mockResolvedValue(undefined)
    const discard = vi.fn()
    render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable
      startGuidedCapture={vi.fn().mockResolvedValue(original)} discardGuidedCapture={discard} onSaveDraft={save} />)
    await start()
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(composeGuidedPanorama).toHaveBeenCalledWith(original, expect.any(Function), 2048, expect.any(AbortSignal))
    expect(getSavedNativeCaptures).toHaveBeenCalledWith(owner, expect.any(Object))
    expect(getNativePanoramaStitchStatus).not.toHaveBeenCalled()
    expect(checkAiPanoramaHealth).not.toHaveBeenCalled()
    expect(assembleAiNativePanorama).not.toHaveBeenCalled()
    expect(assembleNativePanorama).not.toHaveBeenCalled()
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      captureSessionId: original.sessionId, width: 2048, height: 1024,
    })))
    expect(discard).not.toHaveBeenCalled()
    expect(screen.getByText(/blending cannot repair camera movement or pose drift/)).toBeInTheDocument()
  })

  it('uses the same standard compositor for non-Android native capture without a computer', async () => {
    platform.android = false
    const original = capture('clerk:shared-ios')
    render(<Capture360Page initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(original)} />)
    await start()
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(composeGuidedPanorama).toHaveBeenCalledWith(original, expect.any(Function), 2048, expect.any(AbortSignal))
    expect(checkAiPanoramaHealth).not.toHaveBeenCalled()
    expect(getNativePanoramaStitchStatus).not.toHaveBeenCalled()
    expect(getSavedNativeCaptures).not.toHaveBeenCalled()
  })

  it('does not automatically retry a source session already saved in owned Memories', async () => {
    const owner = 'clerk:shared-saved'
    const saved = capture(owner, 'already-saved')
    const fresh = capture(owner, 'new-session')
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    const begin = vi.fn().mockResolvedValue(fresh)
    render(<Capture360Page captureOwnerKey={owner} savedCaptureSessionIds={['already-saved']}
      initialMode="manual" guidedCaptureAvailable startGuidedCapture={begin} />)
    await screen.findByText(/already saved in Memories/)
    expect(screen.queryByRole('button', { name: 'Retry assembly from saved photos' })).not.toBeInTheDocument()
    await start()
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(begin).toHaveBeenCalledTimes(1)
    expect(composeGuidedPanorama).toHaveBeenCalledWith(fresh, expect.any(Function), 2048, expect.any(AbortSignal))
  })

  it('reopens a completed advanced result in standard mode without reassembly', async () => {
    const owner = 'clerk:shared-open'
    const saved = { ...capture(owner), assembly: { state: 'completed' as const } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    const open = await screen.findByRole('button', { name: 'Open finished sphere' })
    await waitFor(() => expect(open).toBeEnabled())
    await userEvent.click(open)
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(openSavedNativePanorama).toHaveBeenCalledWith(saved, expect.objectContaining({ ownerKey: owner }))
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })

  it('clears a discovered pending set when owned Memories finish hydrating', async () => {
    const owner = 'clerk:shared-hydration'
    const saved = capture(owner)
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    const props = { captureOwnerKey: owner, initialMode: 'manual' as const, guidedCaptureAvailable: true }
    const view = render(<Capture360Page {...props} savedCaptureSessionIds={[]} />)
    await screen.findByRole('button', { name: 'Retry assembly from saved photos' })
    view.rerender(<Capture360Page {...props} savedCaptureSessionIds={[saved.sessionId]} />)
    await screen.findByRole('button', { name: 'Start guided 360 capture' })
    expect(screen.queryByRole('button', { name: 'Retry assembly from saved photos' })).not.toBeInTheDocument()
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
  })

  it('keeps a running advanced job recoverable after saved-session hydration', async () => {
    const owner = 'clerk:shared-running-hydration'
    const running = { ...capture(owner), assembly: { state: 'running' as const, jobId: 'running-again' } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([running])
    const props = { captureOwnerKey: owner, initialMode: 'manual' as const, guidedCaptureAvailable: true }
    const view = render(<Capture360Page {...props} savedCaptureSessionIds={[]} />)
    await screen.findByRole('button', { name: 'Retry assembly from saved photos' })
    view.rerender(<Capture360Page {...props} savedCaptureSessionIds={[running.sessionId]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Resume progress' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(assembleNativePanorama).toHaveBeenCalledWith(running, expect.objectContaining({ ownerKey: owner }))
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
  })

  it('requires explicit rebuild of rejected legacy photos and warns before and after blending', async () => {
    const owner = 'clerk:shared-legacy'
    const saved = capture(owner)
    const rejected = { ...saved, frames: saved.frames.map((frame) => ({ ...frame, poseSource: 'arcoreDisplayOrientedPose' })),
      assembly: { state: 'failed' as const, code: 'quality_rejected', error: 'Not enough reliable alignments.' } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([rejected])
    render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    await screen.findByText(/These photos use older Android tracking coordinates/)
    expect(screen.getByText(/Advanced alignment previously rejected these photos/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry assembly from saved photos' })).not.toBeInTheDocument()
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    const retry = screen.getByRole('button', { name: 'Retry on this phone' })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(composeGuidedPanorama).toHaveBeenCalledWith(rejected, expect.any(Function), 2048, expect.any(AbortSignal))
    expect(screen.getByText(/This blend does not establish that their alignment is correct/)).toBeInTheDocument()
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })

  it('does not label current anchor-relative tracking as legacy', async () => {
    const owner = 'clerk:shared-anchor'
    const original = capture(owner)
    const anchored = { ...original, frames: original.frames.map((frame) => ({ ...frame,
      poseSource: 'arcoreDisplayOrientedPose+captureAnchor', coordinateFrameId: 'anchor-session' })) }
    render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable
      startGuidedCapture={vi.fn().mockResolvedValue(anchored)} />)
    await start()
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(screen.queryByText(/These photos use older Android tracking coordinates/)).not.toBeInTheDocument()
  })

  it('rejects a native result belonging to another owner before reading its photos', async () => {
    render(<Capture360Page captureOwnerKey="clerk:shared-owner" initialMode="manual" guidedCaptureAvailable
      startGuidedCapture={vi.fn().mockResolvedValue(capture('clerk:someone-else'))} />)
    await start()
    expect(await screen.findByRole('alert')).toHaveTextContent('not available for this account')
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
  })

  it('resumes an already-running advanced job instead of starting a shared composition', async () => {
    const owner = 'clerk:shared-resume'
    const running = { ...capture(owner), assembly: { state: 'running' as const, jobId: 'existing-job', stage: 'matching', progress: 0.2 } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([running])
    render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    const resume = await screen.findByRole('button', { name: 'Resume progress' })
    await waitFor(() => expect(resume).toBeEnabled())
    await userEvent.click(resume)
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(assembleNativePanorama).toHaveBeenCalledWith(running, expect.objectContaining({ ownerKey: owner }))
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(assembleAiNativePanorama).not.toHaveBeenCalled()
  })

  it('stops standard composition cooperatively without saving or deleting sources', async () => {
    const owner = 'clerk:shared-stop'
    let signal: AbortSignal | undefined
    vi.mocked(composeGuidedPanorama).mockImplementation((_capture, _progress, _width, requestedSignal) => {
      signal = requestedSignal
      return new Promise((_resolve, reject) => requestedSignal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
    })
    const save = vi.fn(), discard = vi.fn()
    render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable
      startGuidedCapture={vi.fn().mockResolvedValue(capture(owner))} discardGuidedCapture={discard} onSaveDraft={save} />)
    await start()
    expect(await screen.findByText(/Leaving this screen stops assembly/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop assembly' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop assembly' })).not.toBeInTheDocument())
    expect(signal?.aborted).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry assembly from saved photos' })).toBeEnabled()
    expect(screen.getByText('Assembly stopped. Your source photos are kept for another try.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('aborts only the shared work when its page unmounts', async () => {
    const owner = 'clerk:shared-leave'
    let signal: AbortSignal | undefined
    vi.mocked(composeGuidedPanorama).mockImplementation((_capture, _progress, _width, requestedSignal) => {
      signal = requestedSignal
      return new Promise((_resolve, reject) => requestedSignal?.addEventListener('abort', () => reject(new DOMException('Detached', 'AbortError')), { once: true }))
    })
    const first = render(<Capture360Page captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable
      startGuidedCapture={vi.fn().mockResolvedValue(capture(owner))} />)
    await start()
    await screen.findByRole('button', { name: 'Stop assembly' })
    await act(async () => first.unmount())
    expect(signal?.aborted).toBe(true)
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })

  it('keeps computer generation and advanced alignment explicit optional navigation', async () => {
    const ai = vi.fn(), advanced = vi.fn()
    render(<Capture360Page initialMode="manual" onOpenAiGeneration={ai} onOpenAdvancedAssembly={advanced} />)
    await userEvent.click(screen.getByText('Other creation options'))
    await userEvent.click(screen.getByRole('button', { name: 'Advanced alignment' }))
    await userEvent.click(screen.getByRole('button', { name: 'AI-generated scene on your computer' }))
    expect(ai).toHaveBeenCalledTimes(1)
    expect(advanced).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Choose overlapping source photos for AI assembly')).not.toBeInTheDocument()
    expect(getNativePanoramaStitchStatus).not.toHaveBeenCalled()
    expect(checkAiPanoramaHealth).not.toHaveBeenCalled()
  })
})
