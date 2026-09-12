import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CaptureStartPanel } from './CaptureStartPanel'
import type { DailyCapturePhase } from './captureWindow'
import type { CaptureSource } from './captureTypes'

function panelProps() {
  return {
    source: 'manual' as CaptureSource,
    phase: 'upcoming' as DailyCapturePhase,
    captureWindow: { startsAt: new Date('2026-09-12T12:00:00'), endsAt: new Date('2026-09-12T12:15:00') },
    interactionBusy: false,
    guidedCaptureAvailable: true,
    guidedCaptureRunning: false,
    checking: false,
    guidedCaptureStatus: '',
    error: '',
    connectedFamilySync: true,
    guidedCaptureButtonRef: createRef<HTMLButtonElement>(),
    onGuidedCapture: vi.fn(),
    onOpenPicker: vi.fn(),
    onDailyMode: vi.fn(),
  }
}

describe('CaptureStartPanel', () => {
  it('forwards each manual entry to the matching controller action', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    render(<CaptureStartPanel {...props} />)
    expect(props.guidedCaptureButtonRef.current).toBe(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    await user.click(screen.getByRole('button', { name: 'Start guided 360 capture' }))
    await user.click(screen.getByRole('button', { name: 'Choose finished panorama' }))
    await user.click(screen.getByRole('button', { name: 'Use the phone camera instead' }))
    await user.click(screen.getByRole('button', { name: 'Go to today’s moment' }))
    expect(props.onGuidedCapture).toHaveBeenCalledExactlyOnceWith('manual')
    expect(props.onOpenPicker.mock.calls).toEqual([['manual', 'library'], ['manual', 'camera']])
    expect(props.onDailyMode).toHaveBeenCalledTimes(1)
  })

  it.each(['upcoming', 'closed', 'complete'] as const)('never offers daily capture in the %s phase', (phase) => {
    render(<CaptureStartPanel {...panelProps()} source="daily" phase={phase} />)
    expect(screen.queryByRole('button', { name: 'Capture today in 360°' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload a 360 photo now' })).toBeEnabled()
  })

  it('keeps open-window and manual sources distinct', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    render(<CaptureStartPanel {...props} source="daily" phase="open" />)
    await user.click(screen.getByRole('button', { name: 'Capture today in 360°' }))
    await user.click(screen.getByRole('button', { name: 'Upload a 360 photo now' }))
    expect(props.onGuidedCapture).toHaveBeenCalledExactlyOnceWith('daily')
    expect(props.onOpenPicker).toHaveBeenCalledExactlyOnceWith('manual', 'library')
  })

  it('keeps all competing entry actions disabled while capture is busy', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    render(<CaptureStartPanel {...props} interactionBusy guidedCaptureRunning guidedCaptureStatus="Joining views…" error="Recoverable error" />)
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled()
      await user.click(button)
    }
    expect(screen.getByRole('status')).toHaveTextContent('Joining views…')
    expect(screen.getByRole('alert')).toHaveTextContent('Recoverable error')
    expect(props.onGuidedCapture).not.toHaveBeenCalled()
    expect(props.onOpenPicker).not.toHaveBeenCalled()
    expect(props.onDailyMode).not.toHaveBeenCalled()
  })

  it('labels the browser fallback without starting it automatically', async () => {
    const user = userEvent.setup()
    const props = panelProps()
    render(<CaptureStartPanel {...props} guidedCaptureAvailable={false} />)
    expect(props.onGuidedCapture).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Preview guided capture' }))
    expect(props.onGuidedCapture).toHaveBeenCalledExactlyOnceWith('manual')
    expect(screen.getByText(/This browser shows the interaction preview/)).toBeInTheDocument()
  })
})
