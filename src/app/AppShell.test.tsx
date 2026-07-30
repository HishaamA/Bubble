import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AppShell } from './AppShell'

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="Current route">{location.pathname}{location.search}</output>
}

describe('AppShell', () => {
  it('makes the 360 upload entry point available from a feature tab', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/capsules']}>
        <AppShell><LocationProbe /></AppShell>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole('button', { name: 'Upload a 360 photo now' }))

    expect(screen.getByLabelText('Current route')).toHaveTextContent(
      '/capture?mode=manual',
    )
  })

  it('hides the shortcut while capture is open', () => {
    render(
      <MemoryRouter initialEntries={['/capture?mode=manual']}>
        <AppShell>Capture</AppShell>
      </MemoryRouter>,
    )

    expect(
      screen.queryByRole('button', { name: 'Upload a 360 photo now' }),
    ).not.toBeInTheDocument()
  })
})
