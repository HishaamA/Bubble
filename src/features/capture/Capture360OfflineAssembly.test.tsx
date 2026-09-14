import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Capture360Page } from './Capture360Page'
import { assembleNativePanorama, getSavedNativeCaptures, getNativePanoramaStitchStatus, openSavedNativePanorama } from '../../services/media/nativePanoramaStitch'
import { assembleAiNativePanorama, checkAiPanoramaHealth } from '../../services/media/aiPanorama'
import { composeGuidedPanorama } from '../../services/media/composeGuidedPanorama'

vi.mock('../../services/media/nativePanoramaStitch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/media/nativePanoramaStitch')>(),
  usesNativePanoramaStitch: () => true,
  getNativePanoramaStitchStatus: vi.fn(), getSavedNativeCaptures: vi.fn(), assembleNativePanorama: vi.fn(), openSavedNativePanorama: vi.fn(),
}))
vi.mock('../../services/media/aiPanorama', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/media/aiPanorama')>(),
  checkAiPanoramaHealth: vi.fn(), assembleAiNativePanorama: vi.fn(),
}))
vi.mock('../../services/media/composeGuidedPanorama', () => ({ composeGuidedPanorama: vi.fn() }))
vi.mock('./GuidedPanoramaReview', () => ({ GuidedPanoramaReview: ({ onContinue }: { onContinue: () => void }) => <><h2>Review your 360°</h2><button onClick={onContinue}>Continue review</button></> }))

const ownerKey = 'clerk:phone'
const capture = { ownerKey, directoryUrl: 'file:///durable/phone-session', targetCount: 34, capturedCount: 34,
  frames: Array.from({ length: 34 }, () => ({ width: 1440, height: 1920 })) }
const result = { viewer: new Blob(['sphere'], { type: 'image/jpeg' }), thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
  viewerWidth: 4096, viewerHeight: 2048, thumbnailWidth: 640, thumbnailHeight: 320, report: { aiUsed: true, warnings: ['Inspect nearby objects.'] } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getNativePanoramaStitchStatus).mockReset().mockResolvedValue({ available: true, offline: true, model: 'DISK + LightGlue' })
  vi.mocked(getSavedNativeCaptures).mockReset().mockResolvedValue([])
  vi.mocked(assembleNativePanorama).mockReset().mockResolvedValue(result)
  vi.mocked(openSavedNativePanorama).mockReset().mockResolvedValue(result)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:offline-sphere') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function startCapture() {
  const start = await screen.findByRole('button', { name: 'Start guided 360 capture' })
  await waitFor(() => expect(start).toBeEnabled())
  await userEvent.click(start)
}

describe('offline phone capture', () => {
  it('uses the phone worker and retains original photos through saving and publishing', async () => {
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([]).mockResolvedValue([capture])
    const start = vi.fn().mockResolvedValue(capture)
    const discard = vi.fn()
    const save = vi.fn().mockResolvedValue(undefined)
    const share = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={ownerKey} initialMode="manual" guidedCaptureAvailable startGuidedCapture={start} discardGuidedCapture={discard} onSaveDraft={save} onShare={share} />)
    await startCapture()
    await screen.findByRole('heading', { name: 'Review your 360°' })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(start).toHaveBeenCalledWith({ ownerKey })
    expect(assembleNativePanorama).toHaveBeenCalledWith(capture, expect.objectContaining({ ownerKey }))
    expect(checkAiPanoramaHealth).not.toHaveBeenCalled()
    expect(assembleAiNativePanorama).not.toHaveBeenCalled()
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(screen.getByText(/DISK \+ LightGlue aligned/)).toHaveTextContent('Inspect nearby objects.')
    await userEvent.click(screen.getByRole('button', { name: 'Continue review' }))
    await userEvent.click(screen.getByRole('button', { name: 'Share with family' }))
    await waitFor(() => expect(share).toHaveBeenCalled())
    expect(discard).not.toHaveBeenCalled()
  })

  it('keeps failed sources retryable without a computer or rough fallback', async () => {
    const owner = 'clerk:failed-phone'
    const saved = { ...capture, ownerKey: owner }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([]).mockResolvedValue([saved])
    vi.mocked(assembleNativePanorama).mockRejectedValueOnce(new Error('The views disagree too much.')).mockResolvedValue(result)
    const start = vi.fn().mockResolvedValue(saved)
    const discard = vi.fn()
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable startGuidedCapture={start} discardGuidedCapture={discard} />)
    await startCapture()
    expect(await screen.findByRole('alert')).toHaveTextContent('The views disagree')
    expect(screen.queryByRole('heading', { name: 'Review your 360°' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Retry on this phone' }))
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(composeGuidedPanorama).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
  })

  it('recovers originals after a fresh app mount and confirms removal separately', async () => {
    const owner = 'clerk:restored-phone'
    const saved = { ...capture, ownerKey: owner }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved, { ...saved, directoryUrl: 'file:///durable/incomplete', capturedCount: 9 }])
    const discard = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn()
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable startGuidedCapture={start} discardGuidedCapture={discard} />)
    expect(await screen.findByText('Incomplete capture')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Retry on this phone' })).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry on this phone' })).toBeEnabled())
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove originals' })[0]!)
    expect(discard).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Keep originals' }))
    expect(discard).not.toHaveBeenCalled()
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove originals' })[0]!)
    await userEvent.click(screen.getByRole('button', { name: 'Permanently remove originals' }))
    await waitFor(() => expect(discard).toHaveBeenCalledWith(saved))
    expect(start).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry on this phone' })).not.toBeInTheDocument()
  })

  it('shows cooperative local stage progress and keeps sources on cancellation', async () => {
    const owner = 'clerk:cancelled-phone'
    const saved = { ...capture, ownerKey: owner }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([]).mockResolvedValue([saved])
    vi.mocked(assembleNativePanorama).mockImplementation(async (_capture, options) => {
      options.onProgress?.({ stage: 'matching', progress: 0.32 })
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
    })
    const discard = vi.fn()
    const first = render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(saved)} discardGuidedCapture={discard} />)
    await startCapture()
    expect(await screen.findByRole('progressbar', { name: 'Sphere assembly on this phone' })).toHaveAttribute('value', '0.32')
    expect(screen.getByText('Match')).toHaveAttribute('aria-current', 'step')
    await userEvent.click(screen.getByRole('button', { name: 'Stop assembly' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry on this phone' })).toBeEnabled())
    expect(discard).not.toHaveBeenCalled()
    await act(async () => first.unmount())
  })

  it('opens a completed result recovered after app restart without reassembly', async () => {
    const owner = 'clerk:finished-phone'
    const saved = { ...capture, ownerKey: owner, assembly: { state: 'completed' as const, report: result.report } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    const save = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable onSaveDraft={save} />)
    const open = await screen.findByRole('button', { name: 'Open finished sphere' })
    await waitFor(() => expect(open).toBeEnabled())
    await userEvent.click(open)
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(openSavedNativePanorama).toHaveBeenCalledWith(saved, expect.objectContaining({ ownerKey: owner }))
    expect(assembleNativePanorama).not.toHaveBeenCalled()
    await waitFor(() => expect(save).toHaveBeenCalled())
  })

  it('keeps the last finished sphere accessible when a newer attempt failed', async () => {
    const owner = 'clerk:previous-finished-phone'
    const saved = { ...capture, ownerKey: owner,
      assembly: { state: 'failed' as const, code: 'quality_rejected', error: 'The latest attempt could not align.' },
      savedResult: { state: 'completed' as const, report: result.report },
    }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    const open = await screen.findByRole('button', { name: 'Open finished sphere' })
    await waitFor(() => expect(open).toBeEnabled())
    expect(screen.getByText('The latest attempt could not align.')).toBeInTheDocument()
    await userEvent.click(open)
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(openSavedNativePanorama).toHaveBeenCalledWith(saved, expect.objectContaining({ ownerKey: owner }))
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })

  it('offers an explicit smaller retry only for a persisted memory failure', async () => {
    const owner = 'clerk:memory-phone'
    const saved = { ...capture, ownerKey: owner, assembly: { state: 'failed' as const, code: 'out_of_memory', error: 'Memory exhausted.' } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    const retry = await screen.findByRole('button', { name: 'Retry with less memory' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(assembleNativePanorama).not.toHaveBeenCalled()
    await userEvent.click(retry)
    await screen.findByRole('heading', { name: 'Review your 360°' })
    expect(assembleNativePanorama).toHaveBeenCalledWith(saved, expect.objectContaining({ outputWidth: 2048 }))
  })

  it('requires acknowledgement before removing a finished sphere not known to be in Memories', async () => {
    const owner = 'clerk:remove-finished-phone'
    const saved = { ...capture, ownerKey: owner, assembly: { state: 'completed' as const, report: result.report } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValue([saved])
    const discard = vi.fn().mockResolvedValue(undefined)
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable discardGuidedCapture={discard} />)
    const remove = await screen.findByRole('button', { name: 'Remove originals' })
    await waitFor(() => expect(remove).toBeEnabled())
    await userEvent.click(remove)
    expect(screen.getByRole('button', { name: 'Permanently remove originals' })).toBeDisabled()
    expect(discard).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox', { name: /local finished sphere is also removed/i }))
    await userEvent.click(screen.getByRole('button', { name: 'Permanently remove originals' }))
    await waitFor(() => expect(discard).toHaveBeenCalledWith(saved))
  })

  it('detaches progress when leaving Capture without requesting a native stop', async () => {
    const owner = 'clerk:background-phone'
    const saved = { ...capture, ownerKey: owner }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([]).mockResolvedValue([saved])
    let optionsSeen: Parameters<typeof assembleNativePanorama>[1] | undefined
    vi.mocked(assembleNativePanorama).mockImplementation(async (_capture, options) => {
      optionsSeen = options
      options.onProgress?.({ stage: 'matching', progress: 0.3 })
      return new Promise((_resolve, reject) => options.detachSignal?.addEventListener('abort', () => reject(new DOMException('Detached', 'AbortError')), { once: true }))
    })
    const close = vi.fn()
    const first = render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable startGuidedCapture={vi.fn().mockResolvedValue(saved)} onClose={close} />)
    await startCapture()
    await screen.findByRole('progressbar')
    await userEvent.click(screen.getByRole('button', { name: 'Close 360 capture' }))
    expect(close).toHaveBeenCalled()
    await act(async () => first.unmount())
    expect(optionsSeen?.detachSignal?.aborted).toBe(true)
    expect(optionsSeen?.signal?.aborted).toBe(false)
  })

  it('refreshes a recovered running job to failure and stops status polling without restarting assembly', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const owner = 'clerk:recovered-running-failure'
    const running = { ...capture, ownerKey: owner, assembly: { jobId: 'saved-job', state: 'running' as const, stage: 'checking', progress: 0.71 } }
    const failed = { ...running, assembly: { ...running.assembly, state: 'failed' as const, code: 'quality_rejected', error: 'Too few photos align reliably.' } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([running]).mockResolvedValue([failed])
    const start = vi.fn()
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable startGuidedCapture={start} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/Checking sphere quality · 71%/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume progress' })).toBeEnabled()

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByText('Too few photos align reliably.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume progress' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry on this phone' })).toBeEnabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getSavedNativeCaptures).toHaveBeenCalledTimes(2)
    expect(assembleNativePanorama).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('reveals a recovered completed sphere without opening it or assembling again', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const owner = 'clerk:recovered-running-complete'
    const running = { ...capture, ownerKey: owner, assembly: { jobId: 'saved-job', state: 'running' as const } }
    const completed = { ...running, assembly: { jobId: 'saved-job', state: 'completed' as const, report: result.report } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([running]).mockResolvedValue([completed])
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByRole('button', { name: 'Open finished sphere' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Resume progress' })).not.toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getSavedNativeCaptures).toHaveBeenCalledTimes(2)
    expect(assembleNativePanorama).not.toHaveBeenCalled()
    expect(openSavedNativePanorama).not.toHaveBeenCalled()
  })

  it('pauses background status refresh while hidden and checks promptly when visible again', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const owner = 'clerk:recovered-visibility'
    const running = { ...capture, ownerKey: owner, assembly: { jobId: 'visibility-job', state: 'running' as const } }
    const failed = { ...running, assembly: { state: 'failed' as const, error: 'Background assembly could not align.' } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([running]).mockResolvedValue([failed])
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getSavedNativeCaptures).toHaveBeenCalledTimes(1)
    await act(async () => {
      visibility.mockReturnValue(false)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Background assembly could not align.')).toBeInTheDocument()
    expect(getSavedNativeCaptures).toHaveBeenCalledTimes(2)
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })

  it('aborts stale recovery reads on a profile change and ignores their late result', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const owner = 'clerk:old-recovery-owner'
    const running = { ...capture, ownerKey: owner, assembly: { jobId: 'old-job', state: 'running' as const } }
    const other = { ...capture, ownerKey: 'clerk:new-recovery-owner', assembly: { state: 'failed' as const, error: 'New owner failure.' } }
    let oldResult: ((captures: typeof running[]) => void) | undefined
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([running])
      .mockImplementationOnce(() => new Promise((resolve) => { oldResult = resolve }))
      .mockResolvedValueOnce([other])
    const mounted = render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    const readSignal = vi.mocked(getSavedNativeCaptures).mock.calls[1]?.[1]?.signal
    mounted.rerender(<Capture360Page assemblyMode="advanced" captureOwnerKey={other.ownerKey} initialMode="manual" guidedCaptureAvailable />)
    expect(readSignal?.aborted).toBe(true)
    await act(async () => {
      oldResult?.([running])
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('New owner failure.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume progress' })).not.toBeInTheDocument()
    mounted.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getSavedNativeCaptures).toHaveBeenCalledTimes(3)
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })

  it('stops automatic recovery reads after a timeout and says the worker may still be running', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const owner = 'clerk:recovery-timeout'
    const running = { ...capture, ownerKey: owner, assembly: { jobId: 'timeout-job', state: 'running' as const } }
    vi.mocked(getSavedNativeCaptures).mockResolvedValueOnce([running])
      .mockRejectedValue(new Error('The phone has not returned assembly status yet. Assembly may still be running in the background.'))
    render(<Capture360Page assemblyMode="advanced" captureOwnerKey={owner} initialMode="manual" guidedCaptureAvailable />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByText(/Assembly may still be running in the background/)).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(getSavedNativeCaptures).toHaveBeenCalledTimes(2)
    expect(assembleNativePanorama).not.toHaveBeenCalled()
  })
})
