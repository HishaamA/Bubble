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

    expect(screen.getByRole('heading', { name: 'Upload a 360 now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open camera or library' })).toBeEnabled()
  })

  it('shows the locked daily use case and an always-available manual entry', () => {
    render(
      <Capture360Page
        now={new Date('2026-08-26T10:00:00')}
        dailyWindow={upcomingWindow}
      />,
    )

    expect(screen.getByRole('heading', { name: 'It could happen anytime' })).toBeInTheDocument()
    expect(screen.getByText('Daily capture locked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload a 360 photo now' })).toBeEnabled()

    const input = screen.getByLabelText('Choose a 360 photo from camera or library')
    expect(input).toHaveAttribute('accept', 'image/*')
    expect(input).toHaveAttribute('capture', 'environment')
    expect(screen.getByText(/normal phone camera does not capture/i)).toBeInTheDocument()
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
    await user.type(screen.getByRole('textbox', { name: /add a caption/i }), 'Dinner together')
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledTimes(1))
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({
      file,
      caption: 'Dinner together',
      source: 'manual',
      width: 4000,
      height: 2000,
    }))
    expect(await screen.findByRole('heading', { name: 'Sent to Memories' })).toBeInTheDocument()
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

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a 2:1 equirectangular panorama')
    expect(screen.queryByAltText('Preview of selected 360 panorama')).not.toBeInTheDocument()
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

    await user.click(screen.getByRole('button', { name: 'Choose today’s 360' }))
    await user.upload(
      screen.getByLabelText('Choose a 360 photo from camera or library'),
      new File(['panorama'], 'daily.jpg', { type: 'image/jpeg' }),
    )
    await screen.findByAltText('Preview of selected 360 panorama')
    await user.click(screen.getByRole('button', { name: 'Share with family' }))

    await waitFor(() => expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ source: 'daily' })))
    await user.click(screen.getByRole('button', { name: 'Upload another 360' }))
    await user.click(screen.getByRole('button', { name: 'View today’s daily prompt' }))
    expect(screen.getByText('Daily capture complete')).toBeInTheDocument()
  })
})
