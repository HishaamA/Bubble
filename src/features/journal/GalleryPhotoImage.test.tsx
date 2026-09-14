import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./gallery/phoneGallery', () => ({
  PHONE_GALLERY_CLEARED_EVENT: 'bubble:phone-gallery-cleared', readGalleryPhotoSource: mocks.read,
}))
import { GalleryPhotoImage } from './GalleryPhotoImage'

const source = 'bubble-gallery:one?scope=member%3Afamily&v=one'
const otherSource = 'bubble-gallery:two?scope=member%3Afamily&v=two'
const jpeg = 'data:image/jpeg;base64,/9j/AA=='
function deferred() {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((done) => { resolve = done })
  return { resolve, promise }
}
function cleared(cacheNamespace: string, reason = 'permission') {
  fireEvent(window, new CustomEvent('bubble:phone-gallery-cleared', { detail: { cacheNamespace, reason } }))
}

beforeEach(() => {
  mocks.read.mockReset()
  mocks.read.mockResolvedValue(jpeg)
  vi.stubGlobal('IntersectionObserver', undefined)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('GalleryPhotoImage transient previews', () => {
  it('resolves references to a bounded transient preview without storing bytes or exposing the reference as src', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    render(<GalleryPhotoImage source={source} alt="Family photo" width={240} height={180} />)
    const image = screen.getByRole('img', { name: 'Family photo' })
    expect(image).not.toHaveAttribute('src', source)
    await waitFor(() => expect(image).toHaveAttribute('src', jpeg))
    expect(mocks.read).toHaveBeenCalledWith(source, 1280)
    expect(image).toHaveAttribute('width', '240')
    expect(image).toHaveAttribute('height', '180')
    expect(write).not.toHaveBeenCalled()
  })

  it('waits until a lazy preview approaches the viewport and uses the smaller decode bound', async () => {
    const observed: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('IntersectionObserver', vi.fn(function (callback: IntersectionObserverCallback) {
      const entry = { callback, disconnect: vi.fn() }
      observed.push(entry)
      return { observe: vi.fn(), disconnect: entry.disconnect }
    }))
    render(<GalleryPhotoImage source={source} alt="Lazy family photo" lazy />)
    expect(mocks.read).not.toHaveBeenCalled()
    await act(async () => {
      observed[0].callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(mocks.read).not.toHaveBeenCalled()
    await act(async () => {
      observed[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(mocks.read).toHaveBeenCalledWith(source, 512)
    expect(observed[0].disconnect).toHaveBeenCalled()
    expect(screen.getByRole('img', { name: 'Lazy family photo' })).toHaveAttribute('src', jpeg)
  })

  it('does not let another account’s clearing event blank the current preview', async () => {
    render(<GalleryPhotoImage source={source} alt="Current account photo" />)
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', jpeg))
    cleared('other:family')
    expect(screen.getByRole('img', { name: 'Current account photo' })).toHaveAttribute('src', jpeg)
  })

  it('clears displayed bytes immediately when this account disconnects', async () => {
    render(<GalleryPhotoImage source={source} alt="Private family photo" />)
    const image = screen.getByRole('img')
    await waitFor(() => expect(image).toHaveAttribute('src', jpeg))
    cleared('member:family', 'disconnect')
    expect(image).not.toHaveAttribute('src')
    expect(screen.getByRole('img', { name: /Private family photo.*unavailable/i })).toHaveTextContent('Photo unavailable')
  })

  it('ignores a late decode after native permission revocation', async () => {
    const pending = deferred()
    mocks.read.mockReturnValue(pending.promise)
    render(<GalleryPhotoImage source={source} alt="Revoked photo" />)
    const image = screen.getByRole('img')
    cleared('member:family', 'permission')
    await act(async () => { pending.resolve(jpeg) })
    expect(image).not.toHaveAttribute('src')
    expect(screen.getByRole('img', { name: /Revoked photo.*unavailable/i })).toBeInTheDocument()
  })

  it('removes transient bytes on unmount and rejects an old source’s late result', async () => {
    const first = deferred()
    const second = deferred()
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<GalleryPhotoImage source={source} alt="Changing photo" />)
    view.rerender(<GalleryPhotoImage source={otherSource} alt="Changing photo" />)
    const image = screen.getByRole('img')
    await act(async () => { first.resolve('data:image/jpeg;base64,b2xk') })
    expect(image).not.toHaveAttribute('src')
    await act(async () => { second.resolve(jpeg) })
    expect(image).toHaveAttribute('src', jpeg)
    view.unmount()
    expect(image).not.toHaveAttribute('src')
  })

  it('recovers when a different source arrives after a failed preview', async () => {
    mocks.read.mockRejectedValueOnce(new Error('Photo unavailable')).mockResolvedValueOnce(jpeg)
    const view = render(<GalleryPhotoImage source={source} alt="Recoverable photo" />)
    await waitFor(() => expect(screen.getByRole('img', { name: /unavailable/i })).toBeInTheDocument())
    view.rerender(<GalleryPhotoImage source={otherSource} alt="Recovered photo" />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'Recovered photo' })).toHaveAttribute('src', jpeg))
    expect(mocks.read).toHaveBeenCalledWith(otherSource, 1280)
  })
})
