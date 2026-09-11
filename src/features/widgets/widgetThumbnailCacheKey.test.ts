import { describe, expect, it } from 'vitest'
import { widgetThumbnailCacheKey } from './widgetThumbnailCacheKey'

describe('widgetThumbnailCacheKey', () => {
  it('reuses an immutable storage photo across signed token renewals', () => {
    expect(widgetThumbnailCacheKey('https://family.test/storage/v1/object/sign/photos/one.jpg?token=old'))
      .toBe(widgetThumbnailCacheKey('https://family.test/storage/v1/object/sign/photos/one.jpg?token=new'))
  })
  it('keeps transform, path and origin changes distinct', () => {
    const original = 'https://family.test/storage/v1/object/sign/photos/one.jpg?token=old&width=384'
    for (const changed of [original.replace('384', '200'), original.replace('one', 'two'), original.replace('family.test', 'another.test')]) {
      expect(widgetThumbnailCacheKey(original)).not.toBe(widgetThumbnailCacheKey(changed))
    }
  })
  it('does not erase query identity for unrelated URLs or Blob sources', () => {
    const url = 'https://example.test/photo?token=version-one'
    expect(widgetThumbnailCacheKey(url)).toBe(url)
    const blob = new Blob(['photo'], { type: 'image/jpeg' })
    expect(widgetThumbnailCacheKey(blob)).toBe(blob)
  })
})
