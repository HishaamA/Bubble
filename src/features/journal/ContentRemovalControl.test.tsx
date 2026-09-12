import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ContentRemovalControl } from './ContentRemovalControl'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

describe('ContentRemovalControl', () => {
  it.each([
    { noun: 'photo' as const, hideOnly: false, label: 'Delete photo' },
    { noun: 'Capsule' as const, hideOnly: false, label: 'Delete Capsule' },
    { noun: 'photo' as const, hideOnly: true, label: 'Hide photo for me' },
    { noun: 'Capsule' as const, hideOnly: true, label: 'Hide Capsule for me' },
  ])('uses a discreet X with an explicit accessible action for $label', async ({ noun, hideOnly, label }) => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ContentRemovalControl noun={noun} hideOnly={hideOnly} compact description="Your choice is confirmed before anything changes." onRemove={onRemove} />)

    const trigger = screen.getByRole('button', { name: label })
    expect(trigger).toHaveTextContent('×')
    expect(trigger).toHaveAttribute('title', label)
    expect(trigger).toHaveClass('journal-photo-delete__compact-trigger')
    expect(trigger.querySelector('span')).toHaveAttribute('aria-hidden', 'true')
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: `Manage ${noun}` })).toHaveClass('journal-photo-delete--confirming')
    expect(screen.getByRole('button', { name: `Keep ${noun}` })).toHaveFocus()
    expect(onRemove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: `Keep ${noun}` }))
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toHaveFocus())
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it.each([
    { noun: 'photo' as const, hideOnly: false, trigger: 'Delete photo', title: 'Delete this photo?' },
    { noun: 'Capsule' as const, hideOnly: false, trigger: 'Delete Capsule', title: 'Delete this Capsule?' },
    { noun: 'photo' as const, hideOnly: true, trigger: 'Hide photo for me', title: 'Hide this photo?' },
    { noun: 'Capsule' as const, hideOnly: true, trigger: 'Hide Capsule for me', title: 'Hide this Capsule?' },
  ])('requires the correctly scoped confirmation for $trigger', async ({ noun, hideOnly, trigger, title }) => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ContentRemovalControl noun={noun} hideOnly={hideOnly} description="Only the scope described here will change." onRemove={onRemove} />)

    expect(screen.getByRole('region', { name: `Manage ${noun}` })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: trigger }))
    const confirmation = screen.getByRole('group', { name: title })
    expect(confirmation).toHaveAccessibleDescription('Only the scope described here will change.')
    expect(confirmation).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('button', { name: `Keep ${noun}` })).toHaveFocus()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('keeps the content untouched and returns focus when confirmation is cancelled', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ContentRemovalControl noun="photo" description="Shared deletion." onRemove={onRemove} />)
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    await user.click(screen.getByRole('button', { name: 'Keep photo' }))
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete photo' })).toHaveFocus())
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('guards repeated confirmation and same-turn cancellation before the busy render', async () => {
    const pending = deferred()
    const onRemove = vi.fn().mockReturnValue(pending.promise)
    render(<ContentRemovalControl noun="Capsule" description="Shared deletion." onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Capsule' }))
    const confirm = screen.getByRole('button', { name: 'Delete Capsule' })
    const keep = screen.getByRole('button', { name: 'Keep Capsule' })
    act(() => { confirm.click(); confirm.click(); keep.click() })
    expect(onRemove).toHaveBeenCalledOnce()
    expect(screen.getByRole('group')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep Capsule' })).toBeDisabled()
    await act(async () => pending.resolve())
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete Capsule' })).toBeEnabled()
  })

  it('preserves confirmation after failure and clears its error during a successful retry', async () => {
    const first = deferred()
    const retry = deferred()
    const onRemove = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    const user = userEvent.setup()
    render(<ContentRemovalControl noun="photo" hideOnly description="Hidden only for this account." onRemove={onRemove} />)
    await user.click(screen.getByRole('button', { name: 'Hide photo for me' }))
    await user.click(screen.getByRole('button', { name: 'Hide photo' }))
    await act(async () => first.reject(new Error('Storage is unavailable.')))
    expect(screen.getByRole('alert')).toHaveTextContent('Storage is unavailable.')
    expect(screen.getByRole('button', { name: 'Keep photo' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Hide photo' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => retry.resolve())
    expect(onRemove).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('uses safe fallback copy for non-Error failures and clears it after cancellation', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn().mockRejectedValue({ unsafeDiagnostic: 'Do not display this raw payload' })
    render(<ContentRemovalControl noun="photo" description="Shared deletion." onRemove={onRemove} />)
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove this item. Please try again.')
    await user.click(screen.getByRole('button', { name: 'Keep photo' }))
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('ignores an unmounted request that later %ss without disturbing its replacement', async outcome => {
    const pending = deferred()
    const oldRemove = vi.fn().mockReturnValue(pending.promise)
    const newRemove = vi.fn().mockResolvedValue(undefined)
    const view = render(<StrictMode><ContentRemovalControl key="old" noun="photo" description="Old account photo." onRemove={oldRemove} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))
    view.rerender(<StrictMode><ContentRemovalControl key="new" noun="Capsule" hideOnly description="New account Capsule." onRemove={newRemove} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Hide Capsule for me' }))
    await act(async () => { if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Late error')) })
    expect(screen.getByRole('group', { name: 'Hide this Capsule?' })).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep Capsule' })).toHaveFocus()
    expect(oldRemove).toHaveBeenCalledOnce()
    expect(newRemove).not.toHaveBeenCalled()
  })
})
