import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapsulePhotoManager } from './CapsulePhotoManager'
import type { CapsulePhoto, FamilyCapsule } from './types'

const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()
function photo(id: string, ownedByCurrentUser: boolean, caption: string): CapsulePhoto {
  return { id, capsuleId: 'capsule-a', image: new Blob([`${id} full-size bytes`]),
    thumbnail: new Blob([`${id} thumbnail bytes`]), width: 900, height: 600,
    caption, capturedAt: '2026-09-12T10:00:00Z', contributorName: 'Test member', ownedByCurrentUser }
}
function capsule(photos = [photo('own-first', true, 'First own photo'), photo('foreign', false, 'Private relative photo'), photo('own-second', true, 'Second own photo')]): FamilyCapsule {
  return { id: 'capsule-a', kind: 'special', title: 'A sealed Capsule',
    createdAt: '2026-09-01T10:00:00Z', closesAt: '2026-09-30T10:00:00Z', opensAt: '2026-09-30T10:00:00Z',
    createdByName: 'Test creator', familySynced: true, photos }
}
beforeEach(() => {
  createObjectURL.mockReset().mockImplementation(() => `blob:manager-${createObjectURL.mock.calls.length}`)
  revokeObjectURL.mockReset()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }))
})
afterEach(() => vi.unstubAllGlobals())

describe('CapsulePhotoManager', () => {
  it('starts collapsed with an owned-photo count and mounts no media or private captions', () => {
    const onDelete = vi.fn()
    const view = render(<CapsulePhotoManager capsule={capsule()} onDelete={onDelete} />)
    expect(screen.getByRole('button', { name: 'Manage my photos (2)' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('img')).toEqual([])
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.textContent).not.toContain('Private relative photo')
    expect(view.container.textContent).not.toContain('First own photo')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('reveals only the uploader’s thumbnails, never another member’s or full-size media', async () => {
    const selected = capsule()
    const view = render(<CapsulePhotoManager capsule={selected} onDelete={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    expect(screen.getByRole('button', { name: 'Close my photos' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(createObjectURL.mock.calls).toEqual([[selected.photos[0].thumbnail], [selected.photos[2].thumbnail]])
    const images = view.container.querySelectorAll('img')
    expect(images).toHaveLength(2)
    images.forEach(image => fireEvent.load(image))
    expect(screen.getByRole('img', { name: 'First own photo' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Second own photo' })).toBeInTheDocument()
    expect(screen.queryByText('Private relative photo')).not.toBeInTheDocument()
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('requires confirmation, supports cancellation, and forwards only the selected photo ID', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<CapsulePhotoManager capsule={capsule()} onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    const second = within(screen.getByText('Second own photo').closest('li')!)
    expect(second.getByRole('button', { name: 'Delete photo' })).toHaveTextContent('×')
    expect(second.getByRole('button', { name: 'Delete photo' })).toHaveAttribute('title', 'Delete photo')
    expect(second.getByRole('button', { name: 'Delete photo' })).toHaveClass('journal-photo-delete__compact-trigger')
    await user.click(second.getByRole('button', { name: 'Delete photo' }))
    expect(second.getByRole('group', { name: 'Delete this photo?' })).toHaveAccessibleDescription(/family recap and Journal entry for everyone/)
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(second.getByRole('button', { name: 'Keep photo' }))
    expect(second.queryByRole('group')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(second.getByRole('button', { name: 'Delete photo' }))
    await user.click(second.getByRole('button', { name: 'Delete photo' }))
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('own-second')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('unmounts previews and resets an unfinished confirmation when the disclosure closes', async () => {
    const onDelete = vi.fn()
    const user = userEvent.setup()
    const view = render(<CapsulePhotoManager capsule={capsule()} onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    await user.click(screen.getAllByRole('button', { name: 'Delete photo' })[0])
    expect(screen.getByRole('group', { name: 'Delete this photo?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close my photos' }))
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(view.container.querySelector('img')).toBeNull()
    expect(revokeObjectURL.mock.calls).toEqual([['blob:manager-1'], ['blob:manager-2']])
    await user.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Delete photo' })).toHaveLength(2)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('does not revive an old error when the panel closes during a deletion and reopens', async () => {
    let reject!: (error: Error) => void
    const onDelete = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const user = userEvent.setup()
    render(<CapsulePhotoManager capsule={capsule()} onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    const first = within(screen.getByText('First own photo').closest('li')!)
    await user.click(first.getByRole('button', { name: 'Delete photo' }))
    await user.click(first.getByRole('button', { name: 'Delete photo' }))
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Close my photos' }))
    await user.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    await act(async () => reject(new Error('Late removal error')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('own-first')
  })

  it.each([
    { label: 'empty Capsule', photos: [] },
    { label: 'foreign contributions only', photos: [photo('foreign', false, 'Someone else’s photo')] },
  ])('renders nothing when there are no owned contributions ($label)', ({ photos }) => {
    const onDelete = vi.fn()
    const view = render(<CapsulePhotoManager capsule={capsule(photos)} onDelete={onDelete} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('removes stale controls when the parent removes the photo or ownership is lost', async () => {
    const selected = capsule()
    const onDelete = vi.fn()
    const user = userEvent.setup()
    const view = render(<CapsulePhotoManager capsule={selected} onDelete={onDelete} />)
    await user.click(screen.getByRole('button', { name: 'Manage my photos (2)' }))
    await user.click(screen.getAllByRole('button', { name: 'Delete photo' })[0])
    view.rerender(<CapsulePhotoManager capsule={{ ...selected, photos: selected.photos.slice(1) }} onDelete={onDelete} />)
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('First own photo')).not.toBeInTheDocument()
    view.rerender(<CapsulePhotoManager capsule={{ ...selected, photos: selected.photos.map(item => ({ ...item, ownedByCurrentUser: false })) }} onDelete={onDelete} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(onDelete).not.toHaveBeenCalled()
  })
})
