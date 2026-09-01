import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AuthBootstrapFailure } from './AuthBootstrapFailure'

describe('AuthBootstrapFailure', () => {
  it('offers a working retry before the app router has mounted', async () => {
    const reload = vi.fn()
    const user = userEvent.setup()
    render(<AuthBootstrapFailure onReload={reload} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your family data has not been changed.',
    )
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
