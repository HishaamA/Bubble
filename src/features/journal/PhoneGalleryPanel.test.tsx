import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PhoneGalleryPanel, type PhoneGalleryConnection } from './PhoneGalleryPanel'

function gallery(overrides: Partial<PhoneGalleryConnection> = {}): PhoneGalleryConnection {
  return {
    supported: true, enabled: false, permission: 'prompt', photos: [], ready: true,
    setupComplete: false, setupPersisted: true, progress: null, error: null,
    connect: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined),
    skipSetup: vi.fn(), disconnect: vi.fn(), openSettings: vi.fn(async () => undefined), ...overrides,
  }
}

describe('one-time gallery invitation and Settings controls', () => {
  it('explains optional local matching and requires an explicit connection', async () => {
    const connection = gallery()
    render(<PhoneGalleryPanel gallery={connection} />)
    expect(screen.getByText(/nothing is uploaded and your originals are not copied/)).toBeVisible()
    expect(screen.getByText(/change this later in Settings/)).toBeVisible()
    expect(connection.connect).not.toHaveBeenCalled()
    expect(connection.openSettings).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Connect gallery' }))
    expect(connection.connect).toHaveBeenCalledOnce()
  })

  it('allows declining without requesting permission and hides after the saved choice', async () => {
    const connection = gallery()
    const view = render(<PhoneGalleryPanel gallery={connection} />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(connection.skipSetup).toHaveBeenCalledOnce()
    expect(connection.connect).not.toHaveBeenCalled()
    view.rerender(<PhoneGalleryPanel gallery={{ ...connection, setupComplete: true }} />)
    expect(screen.queryByRole('region', { name: 'Phone gallery connection' })).not.toBeInTheDocument()
  })

  it.each([
    { enabled: true, setupComplete: true, progress: null },
    { enabled: true, setupComplete: false, progress: { loaded: 100 } },
    { enabled: false, setupComplete: true, progress: null },
  ])('does not bring back the Journal popup for a completed/legacy connection %j', (overrides) => {
    const { container } = render(<PhoneGalleryPanel gallery={gallery(overrides)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps connection available only in Settings after declining', async () => {
    const connection = gallery({ setupComplete: true })
    render(<PhoneGalleryPanel gallery={connection} mode="settings" />)
    expect(screen.getByText('Not connected · optional')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument()
    expect(connection.connect).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Connect gallery' }))
    expect(connection.connect).toHaveBeenCalledOnce()
  })

  it('offers direct Settings management without a second disclosure', async () => {
    const connection = gallery({ enabled: true, setupComplete: true, permission: 'granted' })
    render(<PhoneGalleryPanel gallery={connection} mode="settings" />)
    expect(screen.getByText('Connected · 0 photos')).toBeVisible()
    expect(screen.getByText(/Your connection is remembered/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Manage gallery' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Check for new photos' }))
    expect(connection.refresh).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(connection.disconnect).toHaveBeenCalledOnce()
    expect(connection.connect).not.toHaveBeenCalled()
  })

  it('keeps Disconnect usable during Settings refresh and avoids duplicate requests', async () => {
    const connection = gallery({ enabled: true, permission: 'limited', progress: { loaded: 4697 }, error: 'Some photos are unavailable.' })
    render(<PhoneGalleryPanel gallery={connection} mode="settings" />)
    expect(screen.getByRole('status')).toHaveTextContent('4,697 checked')
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check for new photos' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Change photo access' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(connection.disconnect).toHaveBeenCalledOnce()
  })

  it('opens the selected-photo picker only from Settings Change photo access', async () => {
    const connection = gallery({ enabled: true, permission: 'limited' })
    render(<PhoneGalleryPanel gallery={connection} mode="settings" />)
    expect(screen.getByText(/Only selected photos are connected/)).toBeVisible()
    expect(connection.connect).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Change photo access' }))
    expect(connection.connect).toHaveBeenCalledOnce()
  })

  it('provides the system permission path in Settings after denial', async () => {
    const connection = gallery({ setupComplete: true, permission: 'denied', error: 'Photo access changed.' })
    render(<PhoneGalleryPanel gallery={connection} mode="settings" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Photo access changed.')
    await userEvent.click(screen.getByRole('button', { name: 'Photo permissions' }))
    expect(connection.openSettings).toHaveBeenCalledOnce()
  })

  it('omits the mobile invitation in browsers but explains manual upload in Settings', () => {
    const connection = gallery({ supported: false, permission: 'unavailable' })
    const view = render(<PhoneGalleryPanel gallery={connection} />)
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(<PhoneGalleryPanel gallery={connection} mode="settings" />)
    expect(screen.getByText(/Available in the Android and iOS app/)).toHaveTextContent('add photos manually')
    expect(screen.queryByRole('button', { name: 'Connect gallery' })).not.toBeInTheDocument()
  })
})
