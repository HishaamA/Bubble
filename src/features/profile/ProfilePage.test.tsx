import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ProfilePage } from './ProfilePage'

describe('ProfilePage', () => {
  it('updates accessibility switch state', async () => {
    const user = userEvent.setup()
    render(<ProfilePage />)

    const lowData = screen.getByRole('switch', { name: 'Low-Data Mode' })
    expect(lowData).toHaveAttribute('aria-checked', 'false')
    await user.click(lowData)
    expect(lowData).toHaveAttribute('aria-checked', 'true')
  })
})
