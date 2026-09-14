import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { GalleryScanStatus } from './GalleryScanStatus'
import type { useGalleryScanSession } from './galleryScanSession'

type Scan = ReturnType<typeof useGalleryScanSession>
const state = (overrides: Partial<Scan> = {}): Scan => ({
  status: 'running', total: 4697, scanned: 128, failed: 0, pending: 4569,
  pauseReason: null, requiresRestart: false, pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), ...overrides,
})

describe('GalleryScanStatus', () => {
  it('keeps Retry visible for a final checkpoint handoff failure at 100 percent', () => {
    const scan = state({ status: 'needs-retry', total: 1, scanned: 1, pending: 0 })
    render(<GalleryScanStatus scan={scan} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry unchecked photos' }))
    expect(scan.retry).toHaveBeenCalledOnce()
  })
  it('explains real Android background scanning without requiring the app to stay open', () => {
    render(<GalleryScanStatus scan={state({ backgroundSupported: true, backgroundEnabled: true })} />)
    expect(screen.getByText('Checking photos in background')).toBeInTheDocument()
    expect(screen.getByText(/use other apps or lock your phone/)).toBeInTheDocument()
    expect(screen.queryByText(/while Bubble is open/)).not.toBeInTheDocument()
  })

  it('offers an explicit notification opt-in rather than silently starting invisible work', () => {
    const scan = state({ status: 'paused', backgroundSupported: true, backgroundPermissionRequired: true })
    render(<GalleryScanStatus scan={scan} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable background checking' }))
    expect(scan.retry).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Resume checking' })).not.toBeInTheDocument()
  })

  it('shows real saved progress rather than claiming linked photos are organized', () => {
    const scan = state()
    render(<GalleryScanStatus scan={scan} />)
    expect(screen.getByText('128 / 4,697')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '128')
    expect(screen.getByText(/browse other tabs while Bubble is open/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause checking' }))
    expect(scan.pause).toHaveBeenCalledOnce()
  })

  it('keeps failures visibly incomplete and offers an explicit retry', () => {
    const scan = state({ status: 'needs-retry', failed: 3, scanned: 4694, pending: 0 })
    render(<GalleryScanStatus scan={scan} />)
    expect(screen.getByText(/3 photos could not be checked/)).toBeInTheDocument()
    expect(screen.queryByText('Gallery checked')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry unchecked photos' }))
    expect(scan.retry).toHaveBeenCalledOnce()
  })

  it('requires reopening a poisoned model instead of offering an ineffective retry', () => {
    render(<GalleryScanStatus scan={state({ status: 'needs-retry', requiresRestart: true, error: 'Photo checker stopped responding.' })} />)
    expect(screen.getByText('Photo checker stopped responding.')).toBeInTheDocument()
    expect(screen.getByText(/Close and reopen Bubble/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
  })

  it('explains enrollment priority without allowing the scan to restart over it', () => {
    render(<GalleryScanStatus scan={state({ status: 'paused', pauseReason: 'editor' })} />)
    expect(screen.getByText(/Adding people takes priority/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('lets a manually paused job resume', () => {
    const scan = state({ status: 'paused', pauseReason: 'manual' })
    render(<GalleryScanStatus scan={scan} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume checking' }))
    expect(scan.resume).toHaveBeenCalledOnce()
  })

  it('shows enrollment guidance for people without reference faces', () => {
    render(<GalleryScanStatus scan={state({ status: 'waiting-for-person', scanned: 0 })} />)
    expect(screen.getByText(/Add a person below/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('removes the panel when no gallery is linked', () => {
    const { container } = render(<GalleryScanStatus scan={state({ total: 0, scanned: 0 })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
