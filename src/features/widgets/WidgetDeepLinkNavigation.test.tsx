import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
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

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((complete) => { resolve = complete })
  return { promise, resolve }
}

function NavigationProbe({ storageSubject = 'member:family' }: {
  storageSubject?: string
}) {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <WidgetDeepLinkHandler storageSubject={storageSubject} />
      <output aria-label="Current page">{location.pathname}</output>
      <output aria-label="Page context">{JSON.stringify(location.state)}</output>
      <output aria-label="Navigation request">{location.key}</output>
      <button onClick={() => navigate('/journal', { replace: true })}>Close photo</button>
      <button onClick={() => navigate('/capsule')}>Capsule tab</button>
      <button onClick={() => navigate('/')}>Moments tab</button>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  )
}

describe('widget navigation lifecycle', () => {
  it('opens Flights once and allows normal tab navigation afterward', async () => {
    const user = userEvent.setup()
    nativeApp.getLaunchUrl.mockResolvedValue({ url: widgetLink('/journal?section=flights') })
    render(<MemoryRouter><NavigationProbe /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Page context')).toHaveTextContent('"section":"flights"'))
    await user.click(screen.getByRole('button', { name: 'Capsule tab' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/capsule$/)
    await user.click(screen.getByRole('button', { name: 'Moments tab' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
  })
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

    await waitFor(() => expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/))
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"focusMemoryId":"capsule-week-photo"')
    await user.click(screen.getByRole('button', { name: 'Close photo' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    await user.click(screen.getByRole('button', { name: 'Capsule tab' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/capsule$/)
    await user.click(screen.getByRole('button', { name: 'Moments tab' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1)
  })

  it('handles a cold launch once during the Strict Mode setup-cleanup-setup cycle', async () => {
    const launch = deferred<{ url: string } | undefined>()
    nativeApp.getLaunchUrl.mockReturnValue(launch.promise)
    render(
      <StrictMode>
        <MemoryRouter><NavigationProbe /></MemoryRouter>
      </StrictMode>,
    )

    await act(async () => launch.resolve({
      url: widgetLink('/journal/photo/week/strict-photo'),
    }))

    await waitFor(() => expect(screen.getByLabelText('Current page'))
      .toHaveTextContent(/^\/journal$/))
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"focusMemoryId":"capsule-week-strict-photo"')
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
  })

  it('accepts later widget taps after navigating away and cleans up its native listener', async () => {
    const user = userEvent.setup()
    const view = render(<MemoryRouter><NavigationProbe /></MemoryRouter>)
    await waitFor(() => expect(nativeApp.onOpen).not.toBeNull())
    await act(async () => nativeApp.onOpen?.({ url: widgetLink('/journal?section=plans') }))
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"section":"plans"')
    await user.click(screen.getByRole('button', { name: 'Moments tab' }))

    await act(async () => nativeApp.onOpen?.({ url: widgetLink('/journal/photo/week/photo') }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"focusMemoryId":"capsule-week-photo"')
    await user.click(screen.getByRole('button', { name: 'Close photo' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(nativeApp.remove).toHaveBeenCalledTimes(1)
  })

  it('returns through history after repeated warm widget entries without replaying either link', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/capsule']}>
        <NavigationProbe />
      </MemoryRouter>,
    )
    await waitFor(() => expect(nativeApp.onOpen).not.toBeNull())

    await act(async () => nativeApp.onOpen?.({
      url: widgetLink('/journal/photo/week/first'),
    }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"focusMemoryId":"capsule-week-first"')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/capsule$/)

    await act(async () => nativeApp.onOpen?.({ url: widgetLink('/capture?mode=manual') }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/capture$/)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/capsule$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1)
  })

  it('gives every tap on the same Journal photo a new focus request without a new photo page', async () => {
    render(<MemoryRouter initialEntries={['/journal']}><NavigationProbe /></MemoryRouter>)
    await waitFor(() => expect(nativeApp.onOpen).not.toBeNull())
    const url = widgetLink('/journal?photo=photo-1&collection=family-photo-library&source=widget')
    await act(async () => nativeApp.onOpen?.({ url }))
    const firstRequest = screen.getByLabelText('Navigation request').textContent
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"focusMemoryId":"journal-photo-photo-1"')

    await act(async () => nativeApp.onOpen?.({ url }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(screen.getByLabelText('Navigation request').textContent).not.toBe(firstRequest)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.addListener).toHaveBeenCalledTimes(1)
  })

  it('lets a new Journal photo tap beat a delayed legacy-photo cold launch', async () => {
    const launch = deferred<{ url: string } | undefined>()
    nativeApp.getLaunchUrl.mockReturnValue(launch.promise)
    render(<MemoryRouter><NavigationProbe /></MemoryRouter>)
    await waitFor(() => expect(nativeApp.onOpen).not.toBeNull())
    await act(async () => nativeApp.onOpen?.({
      url: widgetLink('/journal?photo=current&collection=family-photo-library&source=widget'),
    }))
    await act(async () => launch.resolve({ url: widgetLink('/journal/photo/week/obsolete') }))
    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"focusPhotoId":"current"')
  })

  it('does not replay a persistent cold-launch URL when the active account changes', async () => {
    const user = userEvent.setup()
    nativeApp.getLaunchUrl.mockResolvedValue({
      url: widgetLink('/journal/photo/week/photo'),
    })
    const view = render(
      <MemoryRouter>
        <NavigationProbe storageSubject="alice:family:a" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByLabelText('Current page'))
      .toHaveTextContent(/^\/journal$/))
    await user.click(screen.getByRole('button', { name: 'Moments tab' }))

    view.rerender(
      <MemoryRouter>
        <NavigationProbe storageSubject="bob:family:b" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(nativeApp.addListener).toHaveBeenCalledTimes(2))

    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
    expect(nativeApp.remove).toHaveBeenCalledTimes(1)
  })

  it('drops an unresolved cold-launch URL when the active account changes', async () => {
    const launch = deferred<{ url: string } | undefined>()
    nativeApp.getLaunchUrl.mockReturnValue(launch.promise)
    const view = render(
      <MemoryRouter>
        <NavigationProbe storageSubject="alice:family:a" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(nativeApp.addListener).toHaveBeenCalledTimes(1))

    view.rerender(
      <MemoryRouter>
        <NavigationProbe storageSubject="bob:family:b" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(nativeApp.addListener).toHaveBeenCalledTimes(2))
    await act(async () => launch.resolve({
      url: widgetLink('/journal/photo/week/alice-private'),
    }))

    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/$/)
    expect(nativeApp.getLaunchUrl).toHaveBeenCalledTimes(1)
  })

  it('lets a newer live widget tap win over a slow stale launch URL', async () => {
    const launch = deferred<{ url: string } | undefined>()
    nativeApp.getLaunchUrl.mockReturnValue(launch.promise)
    render(<MemoryRouter><NavigationProbe /></MemoryRouter>)
    await waitFor(() => expect(nativeApp.onOpen).not.toBeNull())

    await act(async () => nativeApp.onOpen?.({
      url: widgetLink('/journal?section=plans'),
    }))
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"section":"plans"')
    await act(async () => launch.resolve({
      url: widgetLink('/journal/photo/week/stale-photo'),
    }))

    expect(screen.getByLabelText('Current page')).toHaveTextContent(/^\/journal$/)
    expect(screen.getByLabelText('Page context')).toHaveTextContent('"section":"plans"')
  })

  it('removes a listener that finishes registering after unmount', async () => {
    const registration = deferred<{ remove: typeof nativeApp.remove }>()
    nativeApp.addListener.mockReturnValue(registration.promise)
    const view = render(<MemoryRouter><NavigationProbe /></MemoryRouter>)
    view.unmount()

    await act(async () => registration.resolve({ remove: nativeApp.remove }))

    expect(nativeApp.remove).toHaveBeenCalledTimes(1)
  })
})
