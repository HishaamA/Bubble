import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { EventsPage } from './EventsPage'

describe('EventsPage', () => {
  it('updates RSVP and guestbook state locally', async () => {
    const user = userEvent.setup()
    render(<EventsPage />)

    const rsvp = screen.getByRole('button', { name: 'I’m going' })
    await user.click(rsvp)
    expect(screen.getByRole('button', { name: '✓ Going' })).toHaveAttribute('aria-pressed', 'true')

    await user.type(screen.getByRole('textbox', { name: /add a note/i }), 'Save me a seat!')
    await user.click(screen.getByRole('button', { name: 'Add guestbook note' }))

    expect(screen.getByText('Save me a seat!')).toBeInTheDocument()
    expect(screen.getByText('2 notes')).toBeInTheDocument()
  })
})
