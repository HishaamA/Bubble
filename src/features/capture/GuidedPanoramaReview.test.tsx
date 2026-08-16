import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanoramaScene } from '../../viewer'

type ViewerMockProps = {
  ariaLabel?: string
  scenes: PanoramaScene[]
  pointSelectionEnabled?: boolean
  onPointSelect?: (point: { pitch: number; yaw: number }) => void
}

vi.mock('../../viewer', () => ({
  PanoramaViewer: ({
    ariaLabel,
    scenes,
    pointSelectionEnabled,
    onPointSelect,
  }: ViewerMockProps) => (
    <div
      aria-label={ariaLabel}
      data-point-selection-enabled={String(Boolean(pointSelectionEnabled))}
    >
      <button
        type="button"
        disabled={!pointSelectionEnabled}
        onClick={() => onPointSelect?.({ pitch: 12.5, yaw: -38 })}
      >
        Select the table
      </button>
      {scenes[0]?.hotSpots?.map((hotSpot) => (
        <button
          key={hotSpot.id}
          type="button"
          onClick={() => hotSpot.onActivate?.(new Event('click'))}
        >
          Open {hotSpot.label}
        </button>
      ))}
    </div>
  ),
}))

import type { StoredPanoramaAnnotation } from '../memories/shared'
import { GuidedPanoramaReview } from './GuidedPanoramaReview'

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  'mediaDevices',
)

function renderReview(
  annotations: StoredPanoramaAnnotation[] = [],
  onAnnotationsChange = vi.fn(),
) {
  const onContinue = vi.fn()
  const onRetake = vi.fn()
  const view = render(
    <GuidedPanoramaReview
      panoramaUrl="blob:finished-panorama"
      annotations={annotations}
      onAnnotationsChange={onAnnotationsChange}
      onContinue={onContinue}
      onRetake={onRetake}
    />,
  )

  return { ...view, onAnnotationsChange, onContinue, onRetake }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:voice-preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  }
})

describe('GuidedPanoramaReview', () => {
  it('keeps retake and continue available around the full interactive review', async () => {
    const user = userEvent.setup()
    const { onContinue, onRetake } = renderReview()

    expect(screen.getByLabelText('Review your 360 panorama')).toHaveAttribute(
      'data-point-selection-enabled',
      'false',
    )
    expect(screen.getByLabelText('0 of 8 memory points')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retake' }))
    expect(onRetake).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('adds a message only after the user places a point and limits it to 180 characters', async () => {
    const user = userEvent.setup()
    const onAnnotationsChange = vi.fn()
    renderReview([], onAnnotationsChange)

    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    expect(screen.getByLabelText('Review your 360 panorama')).toHaveAttribute(
      'data-point-selection-enabled',
      'true',
    )
    expect(screen.getByRole('status')).toHaveTextContent(/tap the object/i)

    await user.click(screen.getByRole('button', { name: 'Select the table' }))
    expect(screen.getByRole('dialog', { name: /what would you like to add/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /message/i }))

    const message = screen.getByRole('textbox', { name: 'Message' })
    await user.type(message, 'x'.repeat(181))
    expect(message).toHaveValue('x'.repeat(180))
    expect(screen.getByText('180/180')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save message' }))

    expect(onAnnotationsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'text',
        pitch: 12.5,
        yaw: -38,
        message: 'x'.repeat(180),
      }),
    ])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  }, 20_000)

  it('cancels an unsaved point and can delete an existing one', async () => {
    const user = userEvent.setup()
    const point: StoredPanoramaAnnotation = {
      id: 'point-table',
      kind: 'text',
      pitch: 2,
      yaw: 18,
      message: 'Grandma’s flowers',
    }
    const onAnnotationsChange = vi.fn()
    renderReview([point], onAnnotationsChange)

    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    await user.click(screen.getByRole('button', { name: 'Select the table' }))
    await user.click(screen.getByRole('button', { name: /message/i }))
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Not saved')
    await user.click(screen.getByRole('button', { name: 'Cancel editing memory point' }))
    expect(onAnnotationsChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Open Grandma’s flowers' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Grandma’s flowers')
    await user.click(screen.getByRole('button', { name: 'Delete point' }))
    expect(onAnnotationsChange).toHaveBeenCalledWith([])
  })

  it('disables the add button after eight saved points', () => {
    const annotations = Array.from({ length: 8 }, (_, index) => ({
      id: `point-${index}`,
      kind: 'text' as const,
      pitch: index,
      yaw: index * 10,
      message: `Point ${index + 1}`,
    }))
    renderReview(annotations)

    expect(screen.getByRole('button', { name: 'Add a memory point' })).toBeDisabled()
    expect(screen.getByText('All 8 memory points are placed.')).toBeInTheDocument()
  })

  it('records and previews a voice note, then releases microphone and preview resources', async () => {
    const trackStop = vi.fn()
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: trackStop }],
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(mimeType: string) {
        return mimeType === 'audio/webm;codecs=opus'
      }

      state: RecordingState = 'inactive'
      mimeType: string

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super()
        this.mimeType = options?.mimeType ?? 'audio/webm'
      }

      start() {
        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        const dataEvent = new Event('dataavailable')
        Object.defineProperty(dataEvent, 'data', {
          value: new Blob(['voice'], { type: this.mimeType }),
        })
        this.dispatchEvent(dataEvent)
        this.dispatchEvent(new Event('stop'))
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    const onAnnotationsChange = vi.fn()
    renderReview([], onAnnotationsChange)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    await user.click(screen.getByRole('button', { name: 'Select the table' }))
    await user.click(screen.getByRole('button', { name: /^voice/i }))
    const description = screen.getByRole('textbox', {
      name: 'Voice note description',
    })
    expect(description).toHaveAttribute('maxlength', '180')
    await user.click(screen.getByRole('button', { name: 'Start voice recording' }))

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true }))
    expect(screen.getByRole('button', { name: 'Stop voice recording' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop voice recording' }))
    expect(await screen.findByLabelText('Voice note preview')).toHaveAttribute(
      'src',
      'blob:voice-preview',
    )
    const saveVoiceNote = screen.getByRole('button', { name: 'Save voice note' })
    expect(saveVoiceNote).toBeDisabled()
    await user.type(description, 'Dad explains the old family recipe.')
    expect(screen.getByLabelText(
      'Voice note preview: Dad explains the old family recipe.',
    )).toBeInTheDocument()
    await user.click(saveVoiceNote)

    expect(onAnnotationsChange).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'voice',
        pitch: 12.5,
        yaw: -38,
        message: 'Dad explains the old family recipe.',
        audioBlob: expect.any(Blob),
        audioMimeType: 'audio/webm',
      }),
    ])
    expect(trackStop).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-preview')
  })

  it('feature-detects missing voice recording support', async () => {
    const user = userEvent.setup()
    renderReview()

    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    await user.click(screen.getByRole('button', { name: 'Select the table' }))
    expect(screen.getByRole('button', { name: /^voice/i })).toBeDisabled()
    expect(screen.getByText('Unavailable on this device')).toBeInTheDocument()
  })

  it('discards an active recording when the page moves to the background', async () => {
    const trackStop = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    })
    class BackgroundMediaRecorder extends EventTarget {
      static isTypeSupported(mimeType: string) {
        return mimeType === 'audio/webm;codecs=opus'
      }

      state: RecordingState = 'inactive'
      mimeType: string

      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super()
        this.mimeType = options?.mimeType ?? 'audio/webm'
      }

      start() {
        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        this.dispatchEvent(new Event('stop'))
      }
    }
    vi.stubGlobal('MediaRecorder', BackgroundMediaRecorder)
    const user = userEvent.setup()
    renderReview()

    await user.click(screen.getByRole('button', { name: 'Add a memory point' }))
    await user.click(screen.getByRole('button', { name: 'Select the table' }))
    await user.click(screen.getByRole('button', { name: /^voice/i }))
    await user.click(screen.getByRole('button', { name: 'Start voice recording' }))
    expect(await screen.findByRole('button', {
      name: 'Stop voice recording',
    })).toBeInTheDocument()

    window.dispatchEvent(new Event('pagehide'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /moved to the background/i,
    )
    expect(trackStop).toHaveBeenCalled()
    expect(screen.queryByLabelText(/voice note preview/i)).not.toBeInTheDocument()
  })
})
