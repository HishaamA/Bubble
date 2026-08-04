import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AppTabBar } from './AppTabBar'

describe('AppTabBar', () => {
  it('shows the four primary destinations', () => {
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
    ).toEqual(['Moments', 'Journal', 'Together', 'Profile'])

    expect(screen.getByRole('link', { name: 'Moments' })).toHaveAttribute(
      'href',
      '/',
    )
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute(
      'href',
      '/journal',
    )
    expect(screen.getByRole('link', { name: 'Together' })).toHaveAttribute(
      'href',
      '/events',
    )
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/profile',
    )
    expect(screen.getByRole('link', { name: 'Moments' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it.each([
    '/memory/summer-evening',
    '/capture?mode=manual',
    '/relay',
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

  it.each(['/events', '/capsules/family-trip'])(
    'keeps Together active at %s',
    (path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AppTabBar />
        </MemoryRouter>,
      )

      expect(screen.getByRole('link', { name: 'Together' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    },
  )

  it('keeps Profile active on profile routes', () => {
    render(
      <MemoryRouter initialEntries={['/profile/family']}>
        <AppTabBar />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
})
