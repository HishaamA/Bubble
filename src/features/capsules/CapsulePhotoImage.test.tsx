import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapsulePhotoImage } from './CapsulePhotoImage'

const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()

beforeEach(() => {
  createObjectURL.mockReset().mockImplementation(() => `blob:preview-${createObjectURL.mock.calls.length}`)
  revokeObjectURL.mockReset()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }))
})

afterEach(() => vi.unstubAllGlobals())

describe('CapsulePhotoImage', () => {
  it('owns one object URL per Blob and releases it when the preview unmounts', () => {
    const source = new Blob(['photo'])
    const view = render(<CapsulePhotoImage source={source} alt="A picnic" />)
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(source)
    expect(view.container.querySelector('img')).toHaveAttribute('src', 'blob:preview-1')
    expect(screen.getByRole('img', { name: 'A picnic. Loading preview.' })).toBeInTheDocument()
    view.rerender(<CapsulePhotoImage source={source} alt="The same picnic" />)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1')
  })

  it('releases replaced Blob URLs and waits for the new image before marking it ready', () => {
    const ready = vi.fn()
    const first = new Blob(['first'])
    const second = new Blob(['second'])
    const view = render(<CapsulePhotoImage source={first} alt="Family photo" onReady={ready} />)
    fireEvent.load(view.container.querySelector('img')!)
    expect(screen.getByRole('img', { name: 'Family photo' })).not.toHaveAttribute('aria-hidden')
    expect(ready).toHaveBeenCalledTimes(1)
    view.rerender(<CapsulePhotoImage source={second} alt="Family photo" onReady={ready} />)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1')
    expect(screen.getByRole('img', { name: 'Family photo. Loading preview.' })).toBeInTheDocument()
    fireEvent.load(view.container.querySelector('img')!)
    expect(ready).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(revokeObjectURL.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2']])
  })

  it('does not create or revoke capabilities for signed remote URLs', () => {
    const view = render(<CapsulePhotoImage source="https://example.test/photo?signature=renewed" alt="Flowers" />)
    fireEvent.load(view.container.querySelector('img')!)
    expect(screen.getByRole('img', { name: 'Flowers' })).toBeInTheDocument()
    view.unmount()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('releases an owned Blob URL when a renewed remote image replaces it', () => {
    const view = render(<CapsulePhotoImage source={new Blob(['cached'])} alt="Flowers" />)
    view.rerender(<CapsulePhotoImage source="/renewed.jpg" alt="Flowers" />)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1')
    expect(view.container.querySelector('img')).toHaveAttribute('src', '/renewed.jpg')
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it.each(['blob:expired-from-another-session', ''])(
    'never mounts an unrecoverable source (%s)',
    (source) => {
      const view = render(<CapsulePhotoImage source={source} alt="Memory" />)
      expect(view.container.querySelector('img')).toBeNull()
      expect(screen.getByRole('img', { name: 'Memory. Preview unavailable until Bubble reconnects.' })).toBeInTheDocument()
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(revokeObjectURL).not.toHaveBeenCalled()
    },
  )

  it('shows a failed-source placeholder and recovers when the source is renewed', () => {
    const ready = vi.fn()
    const view = render(<CapsulePhotoImage source="/expired.jpg" alt="Memory" onReady={ready} />)
    fireEvent.error(view.container.querySelector('img')!)
    expect(view.container.querySelector('img')).toBeNull()
    expect(screen.getByRole('img', { name: /Preview unavailable/ })).toBeInTheDocument()
    expect(ready).not.toHaveBeenCalled()
    view.rerender(<CapsulePhotoImage source="/renewed.jpg" alt="Memory" onReady={ready} />)
    fireEvent.load(view.container.querySelector('img')!)
    expect(screen.getByRole('img', { name: 'Memory' })).toBeInTheDocument()
    expect(ready).toHaveBeenCalledTimes(1)
  })
})
