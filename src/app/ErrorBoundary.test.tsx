import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function BrokenMemory(): never {
  throw new Error('private render details')
}

afterEach(() => vi.restoreAllMocks())

describe('ErrorBoundary recovery control', () => {
  it('contains render failures and runs the explicit reload action', async () => {
    const reload = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()

    render(
      <ErrorBoundary onReload={reload}>
        <BrokenMemory />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your family content is safe.',
    )
    await user.click(screen.getByRole('button', { name: 'Reload Bubble' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
