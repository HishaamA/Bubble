import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Capture360Page,
  type Capture360Submission,
} from './Capture360Page'
import type { NativePanoramaCaptureResult } from './nativePanoramaCapture'
import type { ProcessedPanorama } from '../../services/media/processPanorama'

const upcomingWindow = {
  startsAt: new Date('2026-08-26T12:00:00'),
  endsAt: new Date('2026-08-26T12:15:00'),
}

function makeGuidedCaptureResult(
  frameCount = 34,
  targetCount = 34,
  capturedCount = targetCount,
): NativePanoramaCaptureResult {
  return {
    frames: Array.from({ length: frameCount }, (_, index) => ({
      width: 1920,
      height: 1440,
      uri: `file:///capture/${index}.jpg`,
      targetYawDegrees: (index % 12) * 30,
      targetPitchDegrees: index < 12 ? -45 : index < 24 ? 0 : 45,
    })),
    targetCount,
    capturedCount,
    directoryUrl: 'file:///capture/session',
  }
}

function makeProcessedPanorama(): ProcessedPanorama {
  return {
    viewer: new Blob(['full sphere'], { type: 'image/jpeg' }),
    thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
    viewerWidth: 2048,
    viewerHeight: 1024,
    thumbnailWidth: 640,
    thumbnailHeight: 320,
  }
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:panorama-preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

describe('Capture360Page', () => {
  it('opens on the guided capture path when initialMode is manual', async () => {
    const user = userEvent.setup()
    render(
      <Capture360Page
        initialMode="manual"
        now={new Date('2026-08-26T10:00:00')}
        dailyWindow={upcomingWindow}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Capture every direction' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview guided capture' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Choose finished panorama' })).toBeEnabled()
    expect(screen.getByText(/each aligned view captures itself/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Preview guided capture' }))
    expect(screen.getByLabelText('Guided 360 capture preview')).toBeInTheDocument()
    expect(screen.getByText(/drag to preview here/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close guided capture preview' }))
    expect(screen.getByRole('heading', { name: 'Capture every direction' })).toBeInTheDocument()
  })

  it('shows the locked daily use case and an always-available manual entry', () => {
    render(
      <Capture360Page
        now={new Date('2026-08-26T10:00:00')}
        dailyWindow={upcomingWindow}
      />,
    )

    expect(screen.getByRole('heading', { name: 'A little moment, sometime today' })).toBeInTheDocument()
    expect(screen.getByText('Today’s moment is locked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload a 360 photo now' })).toBeEnabled()

    const cameraInput = screen.getByLabelText('Take a panorama with camera')
    const libraryInput = screen.getByLabelText('Choose a 360 photo from camera or library')
    expect(cameraInput).toHaveAttribute('accept', 'image/*')
    expect(cameraInput).toHaveAttribute('capture', 'environment')
    expect(libraryInput).not.toHaveAttribute('capture')
    expect(screen.getByText(/including above and below/i)).toBeInTheDocument()
  })

  it('validates, previews, captions, and shares a manual 360 upload', async () => {
    const user = userEvent.setup()
    const onShare = vi.fn()
    const readDimensions = vi.fn().mockResolvedValue({ width: 4000, height: 2000 })
    render(
      <Capture360Page
        now={new Date('2026-08-26T10:00:00')}
        dailyWindow={upcomingWindow}
        onShare={onShare}
        readDimensions={readDimensions}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Upload a 360 photo now' }))
    const file = new File(['panorama'], 'balcony-360.jpg', { type: 'image/jpeg' })
    await user.upload(screen.getByLabelText('Choose a 360 photo from camera or library'), file)

    expect(await screen.findByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose another' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByAltText('Preview of selected 360 panorama')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit 360 & points' }))
    expect(screen.getByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(screen.getByRole('textbox', { name: /moment title/i }), 'Dinner together')
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1))
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({
      file,
      caption: 'Dinner together',
      source: 'manual',
      width: 4000,
      height: 2000,
    }))
    expect(await screen.findByRole('heading', { name: 'Shared with family' })).toBeInTheDocument()
  })

  it('rejects a non-equirectangular image before preview', async () => {
    const user = userEvent.setup()
    render(
      <Capture360Page
        now={new Date('2026-08-26T10:00:00')}
        dailyWindow={upcomingWindow}
        readDimensions={vi.fn().mockResolvedValue({ width: 1600, height: 1200 })}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Upload a 360 photo now' }))
    await user.upload(
      screen.getByLabelText('Choose a 360 photo from camera or library'),
      new File(['photo'], 'phone-photo.jpg', { type: 'image/jpeg' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('This looks like a regular photo')
    expect(screen.queryByAltText('Preview of selected 360 panorama')).not.toBeInTheDocument()
  })

  it('normalizes a wide phone panorama to an exact 2:1 moment before sharing', async () => {
    const user = userEvent.setup()
    const onShare = vi.fn()
    const processedViewer = new Blob(['normalized panorama'], {
      type: 'image/jpeg',
    })
    const processPanorama = vi.fn().mockResolvedValue({
      viewer: processedViewer,
      thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
      viewerWidth: 4096,
      viewerHeight: 2048,
      thumbnailWidth: 640,
      thumbnailHeight: 320,
    })
    render(
      <Capture360Page
        initialMode="manual"
        onShare={onShare}
        readDimensions={vi.fn().mockResolvedValue({ width: 8000, height: 2000 })}
        processPanorama={processPanorama}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Use the phone camera instead' }))
    const phonePanorama = new File(['wide sweep'], 'garden-pano.heic', {
      type: 'image/heic',
    })
    await user.upload(screen.getByLabelText('Take a panorama with camera'), phonePanorama)

    expect(await screen.findByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
    expect(processPanorama).toHaveBeenCalledWith(phonePanorama)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByAltText('Preview of selected 360 panorama')).toBeInTheDocument()
    expect(screen.getByText(/fit the full phone panorama/i)).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: /moment title/i }), 'Garden walk')
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1))
    const submission = onShare.mock.calls[0]?.[0]
    expect(submission).toMatchObject({
      caption: 'Garden walk',
      width: 4096,
      height: 2048,
      source: 'manual',
    })
    expect(submission.file).toBeInstanceOf(File)
    expect(submission.file.name).toBe('garden-pano-360.jpg')
    expect(submission.file.type).toBe('image/jpeg')
  })

  it('disables daily capture while native capture and composition are running', async () => {
    const user = userEvent.setup()
    const nativeCapture = makeDeferred<NativePanoramaCaptureResult>()
    const composition = makeDeferred<ProcessedPanorama>()
    const startGuidedCapture = vi.fn(() => nativeCapture.promise)
    const composeGuidedCapture = vi.fn(() => composition.promise)

    render(
      <Capture360Page
        now={new Date('2026-08-26T12:05:00')}
        dailyWindow={upcomingWindow}
        guidedCaptureAvailable
        startGuidedCapture={startGuidedCapture}
        composeGuidedCapture={composeGuidedCapture}
        discardGuidedCapture={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const captureButton = screen.getByRole('button', { name: 'Capture today in 360°' })
    await user.click(captureButton)
    expect(captureButton).toBeDisabled()

    await act(async () => nativeCapture.resolve(makeGuidedCaptureResult()))
    await waitFor(() => expect(composeGuidedCapture).toHaveBeenCalledTimes(1))
    expect(captureButton).toBeDisabled()

    await act(async () => composition.resolve(makeProcessedPanorama()))
    expect(await screen.findByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
  })

  it('rejects a completed counter when fewer frames than targets were returned', async () => {
    const user = userEvent.setup()
    const composeGuidedCapture = vi.fn()
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)

    render(
      <Capture360Page
        now={new Date('2026-08-26T12:05:00')}
        dailyWindow={upcomingWindow}
        guidedCaptureAvailable
        startGuidedCapture={vi.fn().mockResolvedValue(makeGuidedCaptureResult(33, 34, 34))}
        composeGuidedCapture={composeGuidedCapture}
        discardGuidedCapture={discardGuidedCapture}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Capture today in 360°' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Capture every surrounding dot before finishing.',
    )
    expect(composeGuidedCapture).not.toHaveBeenCalled()
    expect(discardGuidedCapture).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Capture today in 360°' })).toBeEnabled()
  })

  it('uses the daily source only while its window is open', async () => {
    const user = userEvent.setup()
    const onShare = vi.fn()
    const startGuidedCapture = vi.fn().mockResolvedValue({
      frames: Array.from({ length: 34 }, (_, index) => ({
        width: 1920,
        height: 1440,
        uri: `file:///capture/${index}.jpg`,
        targetYawDegrees: (index % 12) * 30,
        targetPitchDegrees: index < 12 ? -45 : index < 24 ? 0 : 45,
      })),
      targetCount: 34,
      capturedCount: 34,
      directoryUrl: 'file:///capture/session',
    })
    const composeGuidedCapture = vi.fn().mockResolvedValue({
      viewer: new Blob(['full sphere'], { type: 'image/jpeg' }),
      thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }),
      viewerWidth: 2048,
      viewerHeight: 1024,
      thumbnailWidth: 640,
      thumbnailHeight: 320,
    })
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)
    render(
      <Capture360Page
        now={new Date('2026-08-26T12:05:00')}
        dailyWindow={upcomingWindow}
        onShare={onShare}
        readDimensions={vi.fn().mockResolvedValue({ width: 4096, height: 2048 })}
        guidedCaptureAvailable
        startGuidedCapture={startGuidedCapture}
        composeGuidedCapture={composeGuidedCapture}
        discardGuidedCapture={discardGuidedCapture}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Capture today in 360°' }))
    expect(await screen.findByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByAltText('Preview of selected 360 panorama')
    expect(startGuidedCapture).toHaveBeenCalledTimes(1)
    expect(composeGuidedCapture).toHaveBeenCalledTimes(1)
    expect(discardGuidedCapture).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ source: 'daily' })))
    await user.click(screen.getByRole('button', { name: 'Share another' }))
    await user.click(screen.getByRole('button', { name: 'Go to today’s moment' }))
    expect(screen.getByText('Today’s moment is shared')).toBeInTheDocument()
  })

  it('saves an assembled guided sphere before cleaning up its native frames and reuses its id when sharing', async () => {
    const user = userEvent.setup()
    const pendingSave = makeDeferred<void>()
    const onSaveDraft = vi.fn<
      (submission: Capture360Submission) => Promise<void>
    >(() => pendingSave.promise)
    const onShare = vi.fn<
      (submission: Capture360Submission) => Promise<void>
    >().mockResolvedValue(undefined)
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)

    render(
      <Capture360Page
        now={new Date('2026-08-26T12:05:00')}
        dailyWindow={upcomingWindow}
        guidedCaptureAvailable
        startGuidedCapture={vi.fn().mockResolvedValue(makeGuidedCaptureResult())}
        composeGuidedCapture={vi.fn().mockResolvedValue(makeProcessedPanorama())}
        discardGuidedCapture={discardGuidedCapture}
        onSaveDraft={onSaveDraft}
        onShare={onShare}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Capture today in 360°' }))
    expect(await screen.findByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1))

    const savedDraft = onSaveDraft.mock.calls[0]![0]
    expect(savedDraft).toMatchObject({
      caption: '',
      source: 'daily',
      width: 2048,
      height: 1024,
      annotations: [],
    })
    expect(savedDraft.id).toEqual(expect.any(String))
    expect(savedDraft.file).toBeInstanceOf(File)
    expect(discardGuidedCapture).not.toHaveBeenCalled()

    await act(async () => pendingSave.resolve(undefined))
    await waitFor(() => expect(discardGuidedCapture).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.type(screen.getByRole('textbox', { name: /moment title/i }), 'Saved sphere')
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1))
    expect(onShare.mock.calls[0]?.[0]).toMatchObject({
      id: savedDraft.id,
      caption: 'Saved sphere',
      createdAt: savedDraft.createdAt,
      file: savedDraft.file,
    })
  })

  it('keeps the assembled review and native frames available when automatic saving fails', async () => {
    const user = userEvent.setup()
    const onSaveDraft = vi.fn<
      (submission: Capture360Submission) => Promise<void>
    >()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue(undefined)
    const discardGuidedCapture = vi.fn().mockResolvedValue(undefined)

    render(
      <Capture360Page
        initialMode="manual"
        guidedCaptureAvailable
        startGuidedCapture={vi.fn().mockResolvedValue(makeGuidedCaptureResult())}
        composeGuidedCapture={vi.fn().mockResolvedValue(makeProcessedPanorama())}
        discardGuidedCapture={discardGuidedCapture}
        onSaveDraft={onSaveDraft}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))

    expect(await screen.findByRole('heading', { name: 'Review your 360°' })).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/i)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:panorama-preview')
    expect(discardGuidedCapture).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Try saving again' }))
    expect(await screen.findByText(/saved safely to memories/i)).toBeInTheDocument()
    expect(onSaveDraft).toHaveBeenCalledTimes(2)
    expect(discardGuidedCapture).toHaveBeenCalledTimes(1)
  })
})
