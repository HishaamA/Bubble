import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GuidedCapturePreview } from './GuidedCapturePreview'

describe('GuidedCapturePreview', () => {
  it('takes focus, contains Tab, and closes with Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<GuidedCapturePreview onClose={onClose} />)

    const close = screen.getByRole('button', {
      name: 'Close guided capture preview',
    })
    await waitFor(() => expect(close).toHaveFocus())

    await user.tab()
    expect(close).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
