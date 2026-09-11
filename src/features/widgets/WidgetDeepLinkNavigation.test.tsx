import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WidgetDeepLinkHandler } from './WidgetDeepLinkHandler'

const nativeApp = vi.hoisted(() => ({
  getLaunchUrl: vi.fn(),
  addListener: vi.fn(),
  remove: vi.fn(),
  onOpen: null as null | ((event: { url: string }) => void),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}))
vi.mock('@capacitor/app', () => ({ App: nativeApp }))

function widgetLink(route: string) {
  return `com.simerfamily.kinsphere://open?route=${encodeURIComponent(route)}`
}

function NavigationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <WidgetDeepLinkHandler storageSubject="member:family" />
      <output aria-label="Current page">{location.pathname}</output>
      <output aria-label="Page context">{JSON.stringify(location.state)}</output>
      <button onClick={() => navigate('/journal', { replace: true })}>Close photo</button>
      <button onClick={() => navigate('/capsule')}>Capsule tab</button>
      <button onClick={() => navigate('/')}>Moments tab</button>
    </>
  )
}

describe('widget navigation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nativeApp.onOpen = null
    nativeApp.getLaunchUrl.mockResolvedValue(undefined)
    nativeApp.addListener.mockImplementation((_name, callback) => {
      nativeApp.onOpen = callback
      return Promise.resolve({ remove: nativeApp.remove })
    })
  })

  it('lets members leave a cold-launch photo and use tabs without replaying the original widget link', async () => {
    const user = userEvent.setup()
    nativeApp.getLaunchUrl.mockResolvedValue({
      url: widgetLink('/journal/photo/week/photo'),
    })
    render(<MemoryRouter><NavigationProbe /></MemoryRouter>)

    await waitFor(() => expect(screen.getByLabelText('Current page')).toHaveTextContent('/journal/photo/week/photo'))
    await user.click(screen.getByRole('button', { name: 'Close photo' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    await user.click(screen.getByRole('button', { name: 'Capsule tab' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/capsule$/)
    await user.click(screen.getByRole('button', { name: 'Moments tab' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1)
  })

  it('accepts later widget taps after navigating away and cleans up its native listener', async () => {
    const user = userEvent.setup()
    const view = render(<MemoryRouter><NavigationProbe /></MemoryRouter>)
    await waitFor(() => expect(nativeApp.onOpen).not.toBeNull())
    await act(async () => nativeApp.onOpen?.({ url: widgetLink('/journal?section=plans') }))
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"section":"plans"')
    await user.click(screen.getByRole('button', { name: 'Moments tab' }))

    await act(async () => nativeApp.onOpen?.({ url: widgetLink('/journal/photo/week/photo') }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent('/journal/photo/week/photo')
    await user.click(screen.getByRole('button', { name: 'Close photo' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(nativeApp.remove).toHaveBeenCalledTimes(1)
  })
})
