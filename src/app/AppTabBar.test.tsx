import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AppTabBar } from './AppTabBar'
import { preloadPrimaryRoute } from './primaryRoutePreload'

vi.mock('./primaryRoutePreload', () => ({ preloadPrimaryRoute: vi.fn().mockResolvedValue(undefined) }))

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{JSON.stringify(location)}</output>
}

describe('AppTabBar', () => {
  it('keeps repeated taps on the current page from adding navigation work', () => {
    render(<MemoryRouter initialEntries={[{ pathname: '/journal', state: { section: 'plans' } }]}>
      <AppTabBar /><LocationProbe />
    </MemoryRouter>)
    const before = screen.getByTestId('location').textContent
    for (let index = 0; index < 8; index++) fireEvent.click(screen.getByRole('link', { name: 'Journal' }))
    expect(screen.getByTestId('location').textContent).toBe(before)
  })

  it('follows the latest destination during rapid tab changes', () => {
    render(<MemoryRouter><AppTabBar /><LocationProbe /></MemoryRouter>)
    for (const name of ['Journal', 'Capsule', 'Moments', 'Journal', 'Moments', 'Capsule']) {
      fireEvent.click(screen.getByRole('link', { name }))
    }
    expect(JSON.parse(screen.getByTestId('location').textContent ?? '{}').pathname).toBe('/capsule')
    expect(screen.getByRole('link', { name: 'Capsule' })).toHaveAttribute('aria-current', 'page')
  })

  it('warms a destination on touch-down or keyboard focus without navigating', () => {
    vi.mocked(preloadPrimaryRoute).mockClear()
    render(<MemoryRouter><AppTabBar /><LocationProbe /></MemoryRouter>)
    fireEvent.pointerDown(screen.getByRole('link', { name: 'Journal' }))
    fireEvent.focus(screen.getByRole('link', { name: 'Capsule' }))
    expect(preloadPrimaryRoute).toHaveBeenNthCalledWith(1, '/journal')
    expect(preloadPrimaryRoute).toHaveBeenNthCalledWith(2, '/capsule')
    expect(JSON.parse(screen.getByTestId('location').textContent ?? '{}').pathname).toBe('/')
  })

  it('shows the three primary destinations', () => {
    render(
      <MemoryRouter>
        <AppTabBar />
      </MemoryRouter>,
    )

    const navigation = screen.getByRole('navigation', {
      name: 'Primary navigation',
    })
    expect(
      within(navigation)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Moments', 'Capsule', 'Journal'])

    expect(screen.getByRole('link', { name: 'Moments' })).toHaveAttribute(
      'href',
      '/',
    )
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute(
      'href',
      '/journal',
    )
    expect(screen.getByRole('link', { name: 'Capsule' })).toHaveAttribute(
      'href',
      '/capsule',
    )
    expect(screen.queryByRole('link', { name: 'Profile' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Moments' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it.each([
    '/memory/summer-evening',
    '/capture?mode=manual',
  ])(
    'keeps Moments active at %s',
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppTabBar />
        </MemoryRouter>,
      )

      expect(screen.getByRole('link', { name: 'Moments' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    },
  )

  it('keeps Journal active on journal routes without activating Moments', () => {
    render(
      <MemoryRouter initialEntries={['/journal/day/2026-08-26']}>
        <AppTabBar />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: 'Moments' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('keeps Journal active while viewing a memory opened from the Journal', () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/memory/mountains',
            state: { returnTo: '/journal', journalContext: { view: 'list' } },
          },
        ]}
      >
        <AppTabBar />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveProperty(
      'href',
      expect.stringContaining('/journal'),
    )
    expect(screen.getByRole('link', { name: 'Moments' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it.each(['/capsule', '/capsule/family-trip'])(
    'keeps Capsule active at %s',
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppTabBar />
        </MemoryRouter>,
      )

      expect(screen.getByRole('link', { name: 'Capsule' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    },
  )

  it('does not add Settings back into the primary navigation', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AppTabBar />
      </MemoryRouter>,
    )

    expect(screen.queryByRole('link', { name: 'Profile' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
  })
})
