import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapsulePhoto, FamilyCapsule } from '../types'

const mocks = vi.hoisted(() => ({
  discardNativeCapsuleRecapArtifacts: vi.fn(), isNativeCapsuleRecapAvailable: vi.fn(),
  renderNativeCapsuleRecap: vi.fn(), shareNativeCapsuleRecap: vi.fn(), stageNativeCapsuleRecapImage: vi.fn(),
  prepareAttributedRecapFrame: vi.fn(),
}))
vi.mock('./nativeCapsuleRecap', () => mocks)
vi.mock('./recapAttribution', () => mocks)

import { CapsuleRecapSheet } from './CapsuleRecapSheet'

function photo(id: string, name: string): CapsulePhoto {
  return {
    id, capsuleId: 'family-week', image: `https://photos.example/${id}.jpg`, thumbnail: `https://photos.example/${id}.jpg`,
    width: 900, height: 1200, caption: `Memory ${id}`, capturedAt: '2026-08-25T10:00:00.000Z',
    contributorName: name, contributorAvatarUrl: `https://profiles.example/${id}.jpg`, ownedByCurrentUser: false,
  }
}

function capsule(photos: CapsulePhoto[]): FamilyCapsule {
  return {
    id: 'family-week', kind: 'special', title: 'Together', createdByName: 'Simreen',
    createdAt: '2026-08-24T00:00:00.000Z', opensAt: '2026-08-31T00:00:00.000Z', closesAt: '2026-08-31T00:00:00.000Z',
    photos, familySynced: true, totalPhotoCount: photos.length,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isNativeCapsuleRecapAvailable.mockReturnValue(true)
  mocks.discardNativeCapsuleRecapArtifacts.mockResolvedValue(undefined)
  mocks.prepareAttributedRecapFrame.mockResolvedValue(new Blob(['with uploader'], { type: 'image/jpeg' }))
  mocks.stageNativeCapsuleRecapImage.mockResolvedValue({ path: 'file:///private/recap/frame.jpg' })
  mocks.renderNativeCapsuleRecap.mockResolvedValue({ fileUri: 'file:///private/recap/video.mp4' })
  mocks.shareNativeCapsuleRecap.mockResolvedValue({ completed: true })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['original']) }))
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('family recap', () => {
  it('plays every family contribution with the uploader avatar, regardless of fetch order', () => {
    vi.useFakeTimers()
    const photos = [photo('b', 'Mum'), photo('a', 'Simreen')]
    render(<CapsuleRecapSheet capsule={capsule(photos)} demoMode={false} onClose={vi.fn()} onPreparePhotos={async () => photos} />)
    const dialog = screen.getByRole('dialog', { name: 'Together' })
    expect(within(dialog).getByRole('img', { name: 'Uploaded by Simreen' })).toBeInTheDocument()
    expect(dialog.querySelector('.capsule-contributor-badge img')).toHaveAttribute('src', 'https://profiles.example/a.jpg')
    act(() => vi.advanceTimersByTime(200))
    expect(within(dialog).getByRole('img', { name: 'Uploaded by Mum' })).toBeInTheDocument()
    expect(dialog.querySelector('.capsule-contributor-badge img')).toHaveAttribute('src', 'https://profiles.example/b.jpg')
  })

  it('exports all contributors in canonical order with attribution before native staging', async () => {
    const photos = [photo('b', 'Mum'), photo('a', 'Simreen')]
    render(<CapsuleRecapSheet capsule={capsule(photos)} demoMode={false} onClose={vi.fn()} onPreparePhotos={async () => photos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save video' }))
    await screen.findByText('Your recap is ready to save or share.')
    expect(mocks.prepareAttributedRecapFrame.mock.calls.map(([, contributor]) => contributor.id)).toEqual(['a', 'b'])
    expect(mocks.stageNativeCapsuleRecapImage).toHaveBeenCalledTimes(2)
    expect(mocks.shareNativeCapsuleRecap).toHaveBeenCalledOnce()
  })

  it('keeps every photo playable but explicitly refuses a truncated oversized video', async () => {
    const photos = Array.from({ length: 151 }, (_, i) => photo(String(i), 'Family'))
    render(<CapsuleRecapSheet capsule={capsule(photos)} demoMode={false} onClose={vi.fn()} onPreparePhotos={async () => photos} />)
    expect(document.querySelectorAll('.capsule-recap-progress > span')).toHaveLength(151)
    fireEvent.click(screen.getByRole('button', { name: 'Save video' }))
    await screen.findByText(/Video export supports up to 150/)
    expect(mocks.stageNativeCapsuleRecapImage).not.toHaveBeenCalled()
    expect(mocks.renderNativeCapsuleRecap).not.toHaveBeenCalled()
  })

  it('does not save a partial film when the server counts photos not yet available locally', async () => {
    const photos = [photo('a', 'Simreen')]
    render(<CapsuleRecapSheet capsule={{ ...capsule(photos), totalPhotoCount: 2 }} demoMode={false} onClose={vi.fn()} onPreparePhotos={async () => photos} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save video' }))
    await screen.findByText('Some family photos are still syncing. Reconnect before saving the combined recap.')
    expect(mocks.stageNativeCapsuleRecapImage).not.toHaveBeenCalled()
  })

  it('can still close while an export is pending', () => {
    const photos = [photo('a', 'Simreen')]
    const onClose = vi.fn()
    render(<CapsuleRecapSheet capsule={capsule(photos)} demoMode={false} onClose={onClose} onPreparePhotos={() => new Promise(() => {})} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save video' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close recap' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
