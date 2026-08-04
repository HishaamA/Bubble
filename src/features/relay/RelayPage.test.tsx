import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { RelayPage } from './RelayPage'

describe('RelayPage', () => {
  it('adds a photo contribution to the family relay', async () => {
    const user = userEvent.setup()
    render(<RelayPage />)

    const sendButton = screen.getByRole('button', { name: 'Share with family' })
    expect(sendButton).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Choose a moment' }))
    expect(sendButton).toBeEnabled()
    await user.click(sendButton)

    expect(screen.getByRole('status')).toHaveTextContent('You’re part of today')
    expect(screen.getByText('You, Mum, Hishaam and Sara have shared')).toBeInTheDocument()
  })
})
