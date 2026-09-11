import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhotoReactionSummary } from '../capsules/photoReactionService'

const mocks = vi.hoisted(() => ({
  fetchPhotoReactions: vi.fn(),
  setPhotoReaction: vi.fn(),
  subscribeToPhotoReactions: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('../capsules/photoReactionService', () => ({
  PHOTO_REACTION_EMOJIS: ['❤️', '🥰', '😂', '😮', '👏'],
  fetchPhotoReactions: mocks.fetchPhotoReactions,
  setPhotoReaction: mocks.setPhotoReaction,
  subscribeToPhotoReactions: mocks.subscribeToPhotoReactions,
}))

import { PhotoReactions } from './PhotoReactions'

function storageKey(scope: string, photoId: string) {
  return `bubble:photo-reaction:v1:${encodeURIComponent(scope)}:${encodeURIComponent(photoId)}`
}

function deferredReactions() {
  let resolve!: (value: PhotoReactionSummary[]) => void
  const promise = new Promise<PhotoReactionSummary[]>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.fetchPhotoReactions.mockResolvedValue([])
  mocks.setPhotoReaction.mockResolvedValue([])
  mocks.subscribeToPhotoReactions.mockReturnValue(mocks.unsubscribe)
})

describe('PhotoReactions', () => {
  it('adds, changes, restores, and removes a local reaction', async () => {
    const user = userEvent.setup()
    const props = { photoId: 'local-photo', storageScope: 'Alice', shared: false }
    const view = render(<PhotoReactions {...props} />)

    expect(screen.getByText('On this device')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Love' }))
    expect(screen.getByRole('button', { name: 'Love, 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem(storageKey('Alice', 'local-photo'))).toBe('❤️')

    await user.click(screen.getByRole('button', { name: 'Laugh' }))
    expect(screen.getByRole('button', { name: 'Love' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Laugh, 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem(storageKey('Alice', 'local-photo'))).toBe('😂')

    view.unmount()
    render(<PhotoReactions {...props} />)
    const restored = screen.getByRole('button', { name: 'Laugh, 1' })
    expect(restored).toHaveAttribute('aria-pressed', 'true')
    await user.click(restored)
    expect(screen.getByRole('button', { name: 'Laugh' })).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem(storageKey('Alice', 'local-photo'))).toBeNull()
    expect(mocks.fetchPhotoReactions).not.toHaveBeenCalled()
    expect(mocks.setPhotoReaction).not.toHaveBeenCalled()
  })

  it('keeps local selections separate when either the photo or account changes', async () => {
    const user = userEvent.setup()
    const view = render(<PhotoReactions photoId="photo:one" storageScope="Alice/family" shared={false} />)
    await user.click(screen.getByRole('button', { name: 'Love' }))

    view.rerender(<PhotoReactions photoId="photo:two" storageScope="Alice/family" shared={false} />)
    expect(screen.getByRole('button', { name: 'Love' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Wow' }))

    view.rerender(<PhotoReactions photoId="photo:one" storageScope="Bob/family" shared={false} />)
    expect(screen.getByRole('button', { name: 'Love' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Wow' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Applause' }))

    view.rerender(<PhotoReactions photoId="photo:one" storageScope="Alice/family" shared={false} />)
    expect(screen.getByRole('button', { name: 'Love, 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Applause' })).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem(storageKey('Alice/family', 'photo:one'))).toBe('❤️')
    expect(localStorage.getItem(storageKey('Alice/family', 'photo:two'))).toBe('😮')
    expect(localStorage.getItem(storageKey('Bob/family', 'photo:one'))).toBe('👏')
  })

  it('displays shared counts and applies the server result when adding and removing a reaction', async () => {
    const user = userEvent.setup()
    mocks.fetchPhotoReactions.mockResolvedValue([
      { emoji: '❤️', count: 2, reactedByMe: false },
      { emoji: '👏', count: 1, reactedByMe: true },
    ])
    mocks.setPhotoReaction.mockResolvedValueOnce([
      { emoji: '❤️', count: 3, reactedByMe: true },
    ]).mockResolvedValueOnce([
      { emoji: '❤️', count: 2, reactedByMe: false },
    ])
    render(<PhotoReactions photoId="shared-photo" storageScope="Alice" shared />)

    expect(screen.getByText('With your family')).toBeInTheDocument()
    const love = await screen.findByRole('button', { name: 'Love, 2' })
    expect(love).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Applause, 1' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(love)

    expect(mocks.setPhotoReaction).toHaveBeenLastCalledWith('shared-photo', '❤️')
    const selectedLove = await screen.findByRole('button', { name: 'Love, 3' })
    expect(selectedLove).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Applause' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(selectedLove)

    expect(mocks.setPhotoReaction).toHaveBeenLastCalledWith('shared-photo', null)
    expect(await screen.findByRole('button', { name: 'Love, 2' })).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.length).toBe(0)
  })

  it('preserves the current count and selection after a rejected submission and allows retry', async () => {
    const user = userEvent.setup()
    mocks.fetchPhotoReactions.mockResolvedValue([
      { emoji: '❤️', count: 4, reactedByMe: true },
    ])
    mocks.setPhotoReaction.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ emoji: '❤️', count: 3, reactedByMe: false }])
    render(<PhotoReactions photoId="shared-photo" storageScope="Alice" shared />)

    await user.click(await screen.findByRole('button', { name: 'Love, 4' }))
    expect(await screen.findByText('Your reaction wasn’t sent. Please try again.')).toBeInTheDocument()
    const unchanged = screen.getByRole('button', { name: 'Love, 4' })
    expect(unchanged).toHaveAttribute('aria-pressed', 'true')
    expect(unchanged).toBeEnabled()
    await user.click(unchanged)
    expect(await screen.findByRole('button', { name: 'Love, 3' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText('Your reaction wasn’t sent. Please try again.')).not.toBeInTheDocument()
    expect(mocks.setPhotoReaction.mock.calls).toEqual([
      ['shared-photo', null], ['shared-photo', null],
    ])
  })

  it('discards an old account or photo request after changing the displayed photo', async () => {
    const oldRequest = deferredReactions()
    mocks.fetchPhotoReactions.mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce([{ emoji: '👏', count: 2, reactedByMe: false }])
    const view = render(<PhotoReactions photoId="old-photo" storageScope="Alice" shared />)
    expect(screen.getByRole('button', { name: 'Love' })).toBeDisabled()

    view.rerender(<PhotoReactions photoId="new-photo" storageScope="Bob" shared />)
    expect(await screen.findByRole('button', { name: 'Applause, 2' })).toHaveAttribute('aria-pressed', 'false')
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
    await act(async () => {
      oldRequest.resolve([{ emoji: '❤️', count: 9, reactedByMe: true }])
      await oldRequest.promise
    })
    expect(screen.getByRole('button', { name: 'Love' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Love, 9' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Applause, 2' })).toBeEnabled()

    mocks.fetchPhotoReactions.mockResolvedValueOnce([{ emoji: '👏', count: 3, reactedByMe: false }])
    const refresh = mocks.subscribeToPhotoReactions.mock.calls.at(-1)?.[1] as () => void
    act(() => refresh())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Applause, 3' })).toBeInTheDocument())
  })
})
