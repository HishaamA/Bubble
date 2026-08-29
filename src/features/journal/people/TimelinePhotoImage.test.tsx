import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TimelinePhotoImage } from './TimelinePhotoImage'

describe('TimelinePhotoImage', () => {
  it('does not create Blob object URLs during render', () => {
    const createObjectUrl = vi.fn(() => 'blob:timeline-photo')
    const original = URL.createObjectURL
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    })
    try {
      renderToString(
        <TimelinePhotoImage
          source={new Blob(['photo'], { type: 'image/jpeg' })}
          alt="Family portrait"
        />,
      )
      expect(createObjectUrl).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: original,
      })
    }
  })

  it('preserves stored landscape dimensions in the rendered image', () => {
    const markup = renderToString(
      <TimelinePhotoImage
        source="/family-landscape.jpg"
        alt="Family dinner"
        width={560}
        height={420}
      />,
    )

    expect(markup).toContain('width="560"')
    expect(markup).toContain('height="420"')
  })
})
