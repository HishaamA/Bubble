import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AppTabBar } from './AppTabBar'

describe('AppTabBar', () => {
  it('puts Capsules first and Memories second', () => {
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
    ).toEqual(['Capsules', 'Memories', 'Relay', 'Events', 'Profile'])
    expect(screen.getByRole('link', { name: 'Memories' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('keeps Memories active throughout the 360 capture flow', () => {
    render(
      <MemoryRouter initialEntries={['/capture?mode=manual']}>
        <AppTabBar />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Memories' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
})
