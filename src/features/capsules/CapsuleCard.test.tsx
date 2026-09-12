import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapsuleCard } from './CapsuleCard'
import { createCurrentWeeklyCapsule } from './capsuleReconciliation'
import type { FamilyCapsule } from './types'

const now = new Date(2026, 7, 29, 12)
const createObjectURL = vi.fn()

function capsule(overrides: Partial<FamilyCapsule> = {}): FamilyCapsule {
  return {
    ...createCurrentWeeklyCapsule(now),
    photos: [{
      id: 'private-photo', capsuleId: 'weekly-2026-08-24',
      image: new Blob(['private image']), thumbnail: new Blob(['private thumbnail']),
      width: 900, height: 1200, caption: 'Private picnic', capturedAt: now.toISOString(),
      contributorName: 'Simreen', ownedByCurrentUser: true, syncStatus: 'pending',
    }],
    totalPhotoCount: 1,
    ...overrides,
  }
}

function props(selected: FamilyCapsule) {
  return {
    capsule: selected, now, uploading: false, demoUnlocked: false, allowLockedPreview: false,
    onChoosePhoto: vi.fn(), onOpenRecap: vi.fn(), onDemoUnlock: vi.fn(),
  }
}

beforeEach(() => {
  createObjectURL.mockReset().mockReturnValue('blob:owned-preview')
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL: vi.fn() }))
})

afterEach(() => vi.unstubAllGlobals())

describe('CapsuleCard', () => {
  it('keeps a sealed special capsule behind safe metadata without mounting private media', () => {
    const sealed = capsule({ kind: 'special', title: 'Demo day' })
    sealed.photos[0].contributorAvatarUrl = 'https://images.example/private-profile.jpg'
    const view = render(<CapsuleCard {...props(sealed)} />)
    expect(screen.getByRole('heading', { name: 'Demo day' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Locked until/ })).toBeInTheDocument()
    expect(screen.getByText('1 photo waiting to share')).toBeInTheDocument()
    expect(view.container.querySelectorAll('img')).toHaveLength(4)
    expect(view.container.querySelector('.capsule-envelope')).toHaveAttribute('data-locked', 'true')
    expect(view.container.querySelector('.capsule-photo-strip__concealed')).toBeNull()
    expect(screen.queryByRole('img', { name: 'Uploaded by Simreen' })).not.toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /recap/i })).not.toBeInTheDocument()
  })

  it.each(['weekly', 'special'] as const)('uses only decorative blurred frames for a locked %s capsule', (kind) => {
    const view = render(<CapsuleCard {...props(capsule({ kind }))} />)
    const images = Array.from(view.container.querySelectorAll('img'))
    expect(images).toHaveLength(4)
    expect(images.every((image) => image.getAttribute('src') === '/assets/capsules/demo-locked-capsule-photos.png')).toBe(true)
    expect(view.container.querySelector('.capsule-empty-polaroids--teasers')).toHaveAttribute('aria-hidden', 'true')
    expect(view.container.querySelector('.capsule-envelope__front')).toBeInTheDocument()
    expect(view.container.querySelector('.capsule-envelope__back')).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('does not mount real media merely because the separate demo action is available', () => {
    const input = props(capsule({ kind: 'special', title: 'Demo day' }))
    const view = render(<CapsuleCard {...input} allowLockedPreview />)
    fireEvent.click(screen.getByRole('button', { name: 'Demo only: Preview Demo day recap' }))
    expect(input.onDemoUnlock).toHaveBeenCalledExactlyOnceWith(input.capsule)
    expect(view.container.querySelectorAll('img')).toHaveLength(4)
    expect(view.container.querySelector('img[src="blob:owned-preview"]')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('mounts unlocked thumbnails and forwards the exact capsule when its recap is opened', () => {
    const input = props(capsule({ opensAt: now.toISOString() }))
    const view = render(<CapsuleCard {...input} />)
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(input.capsule.photos[0].thumbnail)
    expect(view.container.querySelector('input[type="file"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Play recap' }))
    expect(input.onOpenRecap).toHaveBeenCalledExactlyOnceWith(input.capsule)
    expect(screen.getByText('1 photo saved on this phone')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Uploaded by Simreen' })).toBeInTheDocument()
  })

  it.each(['weekly', 'special'] as const)('keeps an old %s recap behind a tappable cover without loading any photos', (kind) => {
    const input = props(capsule({ kind, opensAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000 - 1).toISOString() }))
    input.capsule.photos[0].contributorAvatarUrl = 'https://images.example/private-profile.jpg'
    const view = render(<CapsuleCard {...input} />)
    expect(view.container.querySelector('article')).toHaveAttribute('data-preview', 'keepsake')
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(screen.queryByRole('img', { name: /Uploaded by/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Open .* recap$/ }))
    expect(input.onOpenRecap).toHaveBeenCalledExactlyOnceWith(input.capsule)
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
  })

  it('switches from the photo preview to a closed keepsake just after the four-day boundary', () => {
    const fourDays = 4 * 24 * 60 * 60 * 1000
    const input = props(capsule({ opensAt: new Date(now.getTime() - fourDays).toISOString() }))
    const view = render(<CapsuleCard {...input} />)
    expect(view.container.querySelector('article')).toHaveAttribute('data-preview', 'photos')
    expect(view.container.querySelector('img[src="blob:owned-preview"]')).toBeInTheDocument()
    view.rerender(<CapsuleCard {...input} now={new Date(now.getTime() + 1)} />)
    expect(view.container.querySelector('article')).toHaveAttribute('data-preview', 'keepsake')
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
  })

  it('keeps an unavailable old recap closed without offering an action that cannot work', () => {
    const input = props(capsule({
      opensAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      photos: [], totalPhotoCount: 8,
    }))
    const view = render(<CapsuleCard {...input} />)
    const cover = screen.getByRole('button', { name: /^Open .* recap$/ })
    expect(cover).toBeDisabled()
    fireEvent.click(cover)
    expect(input.onOpenRecap).not.toHaveBeenCalled()
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
  })

  it('does not offer recap playback for remotely counted but unavailable photos', () => {
    render(<CapsuleCard {...props(capsule({ opensAt: now.toISOString(), photos: [], totalPhotoCount: 8 }))} />)
    expect(screen.getByRole('button', { name: 'Photos unavailable on this phone' })).toBeDisabled()
    expect(screen.getByText('8 photos')).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('forwards contributions without changing the parent-owned upload state', () => {
    const input = props(capsule())
    const view = render(<CapsuleCard {...input} />)
    const picker = screen.getByLabelText(/Add photo/)
    const file = new File(['photo'], 'picnic.jpg', { type: 'image/jpeg' })
    fireEvent.change(picker, { target: { files: [file] } })
    expect(input.onChoosePhoto).toHaveBeenCalledExactlyOnceWith(expect.anything(), input.capsule)
    view.rerender(<CapsuleCard {...input} uploading />)
    expect(screen.getByLabelText(/Adding…/)).toBeDisabled()
  })

  it('never mounts a relative’s sealed photo or full-size source in decorative previews', () => {
    const selected = capsule({ kind: 'special', title: 'Family birthday' })
    selected.photos[0] = {
      ...selected.photos[0], ownedByCurrentUser: false,
      image: 'https://private.example/full.jpg', thumbnail: 'https://private.example/thumb.jpg',
    }
    const view = render(<CapsuleCard {...props(selected)} />)
    expect(view.container.innerHTML).not.toContain('https://private.example')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(view.container.querySelector('.capsule-envelope')).toHaveAttribute('data-photo-state', 'single')
  })

  it('keeps an empty special capsule compact without inventing uploaded photos', () => {
    const view = render(<CapsuleCard {...props(capsule({ kind: 'special', photos: [], totalPhotoCount: 0 }))} />)
    expect(view.container.querySelector('.capsule-envelope')).toHaveAttribute('data-photo-state', 'empty')
    expect(screen.getByText('0 photos')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /recap/i })).not.toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('renders management actions in a separate footer without nesting interaction targets', () => {
    const onRemove = vi.fn()
    const input = props(capsule({ opensAt: now.toISOString() }))
    const view = render(<CapsuleCard
      {...input}
      managementActions={<button type="button" onClick={onRemove}>Remove Capsule</button>}
    />)
    const remove = screen.getByRole('button', { name: 'Remove Capsule' })
    expect(remove.parentElement).toHaveClass('capsule-collection__management')
    expect(view.container.querySelector('button button')).toBeNull()
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(input.onOpenRecap).not.toHaveBeenCalled()
  })

  it('places a corner removal action outside the hidden featured header and playback target', () => {
    const onRemove = vi.fn()
    const input = props(capsule({ opensAt: now.toISOString() }))
    const view = render(<CapsuleCard
      {...input}
      hideHeader
      removalAction={<button type="button" aria-label="Delete Capsule" onClick={onRemove}>×</button>}
    />)
    const remove = screen.getByRole('button', { name: 'Delete Capsule' })
    expect(remove.parentElement).toHaveClass('capsule-collection__removal')
    expect(remove.closest('[aria-hidden="true"]')).toBeNull()
    expect(remove.closest('article')).toHaveAttribute('data-has-removal', 'true')
    expect(view.container.querySelector('button button')).toBeNull()
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(input.onOpenRecap).not.toHaveBeenCalled()
  })
})
