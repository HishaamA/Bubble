import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Capture360Page } from './Capture360Page'

const upcomingWindow = {
  startsAt: new Date('2026-08-26T12:00:00'),
  endsAt: new Date('2026-08-26T12:15:00'),
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
  it('opens on the anytime upload path when initialMode is manual', () => {
    render(
      <Capture360Page
        initialMode="manual"
        now={new Date('2026-08-26T10:00:00')}
        dailyWindow={upcomingWindow}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Capture a 360 moment' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Take panoramic photo' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Choose finished panorama' })).toBeEnabled()
    expect(screen.getByText('Hold your phone in landscape.')).toBeInTheDocument()
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
    expect(screen.getByText(/does not invent areas your camera never captured/i)).toBeInTheDocument()
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

    expect(await screen.findByAltText('Preview of selected 360 panorama')).toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: 'Take panoramic photo' }))
    const phonePanorama = new File(['wide sweep'], 'garden-pano.heic', {
      type: 'image/heic',
    })
    await user.upload(screen.getByLabelText('Take a panorama with camera'), phonePanorama)

    expect(await screen.findByAltText('Preview of selected 360 panorama')).toBeInTheDocument()
    expect(processPanorama).toHaveBeenCalledWith(phonePanorama)
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

  it('uses the daily source only while its window is open', async () => {
    const user = userEvent.setup()
    const onShare = vi.fn()
    render(
      <Capture360Page
        now={new Date('2026-08-26T12:05:00')}
        dailyWindow={upcomingWindow}
        onShare={onShare}
        readDimensions={vi.fn().mockResolvedValue({ width: 4096, height: 2048 })}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Take today’s panorama' }))
    await user.upload(
      screen.getByLabelText('Choose a 360 photo from camera or library'),
      new File(['panorama'], 'daily.jpg', { type: 'image/jpeg' }),
    )
    await screen.findByAltText('Preview of selected 360 panorama')
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ source: 'daily' })))
    await user.click(screen.getByRole('button', { name: 'Share another' }))
    await user.click(screen.getByRole('button', { name: 'Go to today’s moment' }))
    expect(screen.getByText('Today’s moment is shared')).toBeInTheDocument()
  })
})
