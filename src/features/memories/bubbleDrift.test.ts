import { describe, expect, it } from 'vitest'
import { createBubbleDrift } from './bubbleDrift'

describe('createBubbleDrift', () => {
  it('gives bubbles stable, varied slow paths', () => {
    expect(createBubbleDrift(0)).toEqual({
      x: '6px',
      y: '5.5px',
      reverseX: '-6px',
      reverseY: '-5.5px',
      duration: '19s',
      delay: '0s',
    })
    expect(createBubbleDrift(1)).toEqual({
      x: '-7.1px',
      y: '10.5px',
      reverseX: '7.1px',
      reverseY: '-10.5px',
      duration: '21.6s',
      delay: '-3.7s',
    })
  })

  it('keeps the featured memory calmer than surrounding bubbles', () => {
    expect(createBubbleDrift(4, true)).toEqual({
      x: '4.5px',
      y: '4px',
      reverseX: '-4.5px',
      reverseY: '-4px',
      duration: '26s',
      delay: '-14.8s',
    })
  })
})
