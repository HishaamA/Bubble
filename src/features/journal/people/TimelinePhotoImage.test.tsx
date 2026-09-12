import { renderToString } from 'react-dom/server'
import { cleanup, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { clearMemberSessionCaches } from '../../../app/memberSessionCache'
import { TimelinePhotoImage, TimelinePhotoPreviewScope } from './TimelinePhotoImage'

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

  it('returns a warm photo src before effects run and keeps standalone cleanup unchanged', () => {
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    const create = vi.fn(() => 'blob:warm-portrait')
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const source = new Blob(['portrait'])
    const committed: Array<string | null> = []
    function WarmJournal() {
      useLayoutEffect(() => { committed.push(screen.getByAltText('Portrait').getAttribute('src')) }, [])
      return <TimelinePhotoPreviewScope namespace="member:family">
        <TimelinePhotoImage source={source} alt="Portrait" />
      </TimelinePhotoPreviewScope>
    }
    try {
      const first = render(<WarmJournal />)
      expect(screen.getByAltText('Portrait')).toHaveAttribute('src', 'blob:warm-portrait')
      first.unmount()
      render(<WarmJournal />)
      expect(committed).toEqual([null, 'blob:warm-portrait'])
      expect(create).toHaveBeenCalledTimes(1)
      cleanup()
      clearMemberSessionCaches()
      expect(revoke).toHaveBeenCalledTimes(1)
      const standalone = render(<TimelinePhotoImage source={source} alt="Standalone" />)
      standalone.unmount()
      expect(create).toHaveBeenCalledTimes(2)
      expect(revoke).toHaveBeenCalledTimes(2)
    } finally {
      cleanup()
      clearMemberSessionCaches()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke })
    }
  })
})
