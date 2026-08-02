import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RelayPage } from './RelayPage'

describe('RelayPage', () => {
  it('creates a local photo contribution', async () => {
    const user = userEvent.setup()
    render(<RelayPage />)

    const sendButton = screen.getByRole('button', { name: 'Add to relay' })
    expect(sendButton).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /choose a moment/i }))
    expect(sendButton).toBeEnabled()
    await user.click(sendButton)

    expect(screen.getByRole('status')).toHaveTextContent('Added to today’s relay')
    expect(screen.getByText('4 of 6 shared')).toBeInTheDocument()
  })
})
