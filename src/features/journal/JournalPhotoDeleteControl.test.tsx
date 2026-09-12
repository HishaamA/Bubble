import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JournalPhotoDeleteControl } from './JournalPhotoDeleteControl'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('JournalPhotoDeleteControl', () => {
  it('shows a small X instead of a prominent delete label while keeping the action discoverable', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<JournalPhotoDeleteControl photoId="photo-a" shared onDelete={onDelete} />)
    const trigger = screen.getByRole('button', { name: 'Delete my photo' })
    expect(trigger).toHaveTextContent('×')
    expect(trigger).toHaveAttribute('title', 'Delete my photo')
    expect(trigger).toHaveClass('journal-photo-delete__compact-trigger')
    expect(trigger.querySelector('span')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('region', { name: 'Manage your photo' })).toHaveClass('journal-photo-delete--compact')
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('region', { name: 'Manage your photo' })).toHaveClass('journal-photo-delete--confirming')
    expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('requires confirmation, explains shared removal and focuses the safe action', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<JournalPhotoDeleteControl photoId="photo-a" shared onDelete={onDelete} />)

    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete my photo' }))

    const confirmation = screen.getByRole('group', { name: 'Delete this photo?' })
    expect(confirmation).toHaveAccessibleDescription(/shared Journal for everyone in your family/)
    expect(confirmation).toHaveTextContent('original phone photo, separate Capsule copies, and saved downloads stay unchanged')
    expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Delete photo' }))
      .toHaveAccessibleDescription(/shared Journal/)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('cancels without deleting and restores focus to the original trigger', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<JournalPhotoDeleteControl photoId="photo-a" shared={false} onDelete={onDelete} />)

    await user.click(screen.getByRole('button', { name: 'Delete my photo' }))
    expect(screen.getByRole('group', { name: 'Delete this photo?' }))
      .toHaveAccessibleDescription(/from this Journal/)
    await user.click(screen.getByRole('button', { name: 'Keep photo' }))

    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete my photo' })).toHaveFocus())
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('serializes same-turn delete taps and prevents cancellation before the busy paint', async () => {
    const pending = deferred()
    const onDelete = vi.fn().mockReturnValue(pending.promise)
    render(<JournalPhotoDeleteControl photoId="photo-a" shared onDelete={onDelete} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    const confirm = screen.getByRole('button', { name: 'Delete photo' })
    const keep = screen.getByRole('button', { name: 'Keep photo' })

    act(() => {
      confirm.click()
      confirm.click()
      keep.click()
    })

    expect(onDelete).toHaveBeenCalledExactlyOnceWith('photo-a')
    expect(screen.getByRole('group', { name: 'Delete this photo?' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep photo' })).toBeDisabled()
    await act(async () => pending.resolve())
    expect(screen.queryByRole('group', { name: 'Delete this photo?' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete my photo' })).toBeEnabled()
  })

  it('keeps a failed photo in place, exposes the error and allows a guarded retry', async () => {
    const first = deferred()
    const retry = deferred()
    const onDelete = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    const user = userEvent.setup()
    render(<JournalPhotoDeleteControl photoId="photo-a" shared onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Delete my photo' }))
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    await act(async () => first.reject(new Error('Network unavailable')))

    expect(screen.getByRole('alert')).toHaveTextContent('The photo wasn’t deleted')
    expect(screen.getByRole('button', { name: 'Delete photo' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Keep photo' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deleting…' })).toBeDisabled()
    await act(async () => retry.resolve())
    expect(onDelete).toHaveBeenNthCalledWith(2, 'photo-a')
    expect(screen.getByRole('button', { name: 'Delete my photo' })).toBeEnabled()
  })

  it('clears a failure when the user keeps the photo and opens confirmation again', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('No connection'))
    const user = userEvent.setup()
    render(<JournalPhotoDeleteControl photoId="photo-a" shared onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Delete my photo' }))
    await user.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep photo' }))
    await user.click(screen.getByRole('button', { name: 'Delete my photo' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('does not affect a replacement control when an unmounted deletion later %ss', async (outcome) => {
    const oldRequest = deferred()
    const onDeleteOld = vi.fn().mockReturnValue(oldRequest.promise)
    const onDeleteNew = vi.fn().mockResolvedValue(undefined)
    const view = render(<StrictMode><JournalPhotoDeleteControl key="old" photoId="old-photo" shared onDelete={onDeleteOld} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))
    view.rerender(<StrictMode><JournalPhotoDeleteControl key="new" photoId="new-photo" shared onDelete={onDeleteNew} /></StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Delete my photo' }))

    await act(async () => {
      if (outcome === 'resolve') oldRequest.resolve()
      else oldRequest.reject(new Error('Late failure for old photo'))
    })

    expect(screen.getByRole('group', { name: 'Delete this photo?' })).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus()
    expect(onDeleteOld).toHaveBeenCalledExactlyOnceWith('old-photo')
    expect(onDeleteNew).not.toHaveBeenCalled()
  })
})
