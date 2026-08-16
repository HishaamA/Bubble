import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredPanoramaAnnotation } from '../memories/shared'

vi.mock('./GuidedPanoramaReview', () => ({
  GuidedPanoramaReview: ({
    onAnnotationsChange,
    onContinue,
  }: {
    onAnnotationsChange: (annotations: StoredPanoramaAnnotation[]) => void
    onContinue: () => void
  }) => (
    <section aria-label="Mock panorama review">
      <button
        type="button"
        onClick={() =>
          onAnnotationsChange([
            {
              id: 'voice-point-1',
              kind: 'voice',
              pitch: 4,
              yaw: -28,
              message: 'Grandma singing Happy Birthday',
              audioBlob: new Blob(['voice'], { type: 'audio/mp4' }),
              audioMimeType: 'audio/mp4',
              durationMs: 2_400,
            },
          ])
        }
      >
        Add voice point
      </button>
      <button
        type="button"
        onClick={() =>
          onAnnotationsChange([
            {
              id: 'voice-point-1',
              kind: 'voice',
              pitch: 4,
              yaw: -28,
              message: 'Grandma finishing Happy Birthday',
              audioBlob: new Blob(['new voice'], { type: 'audio/mp4' }),
              audioMimeType: 'audio/mp4',
              durationMs: 2_900,
            },
          ])
        }
      >
        Replace voice point
      </button>
      <button type="button" onClick={onContinue}>Continue review</button>
    </section>
  ),
}))

import {
  Capture360Page,
  type Capture360Submission,
} from './Capture360Page'

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:panorama-preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

describe('Capture360Page draft annotation durability', () => {
  it('autosaves imported spheres and every voice-point change before continuing', async () => {
    const user = userEvent.setup()
    const onSaveDraft = vi.fn<
      (submission: Capture360Submission) => Promise<void>
    >().mockResolvedValue(undefined)

    render(
      <Capture360Page
        initialMode="manual"
        onSaveDraft={onSaveDraft}
        readDimensions={vi.fn().mockResolvedValue({
          width: 4096,
          height: 2048,
        })}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Choose finished panorama' }),
    )
    await user.upload(
      screen.getByLabelText('Choose a 360 photo from camera or library'),
      new File(['panorama'], 'family-room.jpg', { type: 'image/jpeg' }),
    )

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1))
    expect(onSaveDraft.mock.calls[0]?.[0].annotations).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Add voice point' }))
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(2))
    expect(onSaveDraft.mock.calls[1]?.[0].annotations).toEqual([
      expect.objectContaining({
        id: 'voice-point-1',
        kind: 'voice',
        message: 'Grandma singing Happy Birthday',
        audioBlob: expect.any(Blob),
      }),
    ])

    await user.click(screen.getByRole('button', { name: 'Continue review' }))
    expect(
      await screen.findByAltText('Preview of selected 360 panorama'),
    ).toBeInTheDocument()
  })

  it('does not show a stale failure after a newer queued point save succeeds', async () => {
    const user = userEvent.setup()
    let rejectOlderSave: (reason: Error) => void = () => undefined
    let resolveLatestSave: () => void = () => undefined
    const olderSave = new Promise<void>((_resolve, reject) => {
      rejectOlderSave = reject
    })
    const latestSave = new Promise<void>((resolve) => {
      resolveLatestSave = resolve
    })
    const onSaveDraft = vi.fn(
      (submission: Capture360Submission): Promise<void> => {
        const description = submission.annotations?.[0]?.message
        if (description === 'Grandma singing Happy Birthday') return olderSave
        if (description === 'Grandma finishing Happy Birthday') return latestSave
        return Promise.resolve()
      },
    )

    render(
      <Capture360Page
        initialMode="manual"
        onSaveDraft={onSaveDraft}
        readDimensions={vi.fn().mockResolvedValue({
          width: 4096,
          height: 2048,
        })}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: 'Choose finished panorama' }),
    )
    await user.upload(
      screen.getByLabelText('Choose a 360 photo from camera or library'),
      new File(['panorama'], 'family-room.jpg', { type: 'image/jpeg' }),
    )
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Add voice point' }))
    await user.click(screen.getByRole('button', { name: 'Replace voice point' }))
    expect(onSaveDraft).toHaveBeenCalledTimes(2)

    rejectOlderSave(new Error('older write failed'))
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(3))
    resolveLatestSave()

    expect(
      await screen.findByText('Saved safely to Memories on this device.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
