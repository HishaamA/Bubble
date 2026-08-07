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
      phoneX: '7.8px',
      phoneY: '6.9px',
      phoneReverseX: '-7.8px',
      phoneReverseY: '-6.9px',
      phoneDuration: '17s',
    })
    expect(createBubbleDrift(1)).toEqual({
      x: '-7.1px',
      y: '10.5px',
      reverseX: '7.1px',
      reverseY: '-10.5px',
      duration: '21.6s',
      delay: '-3.7s',
      phoneX: '-9.2px',
      phoneY: '13px',
      phoneReverseX: '9.2px',
      phoneReverseY: '-13px',
      phoneDuration: '17.7s',
    })
  })
})
