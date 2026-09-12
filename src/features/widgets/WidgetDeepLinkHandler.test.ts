import { describe, expect, it } from 'vitest'
import { parseBubbleWidgetDeepLink } from './widgetDeepLink'

function link(route: string) {
  return `com.simerfamily.kinsphere://open?route=${encodeURIComponent(route)}`
}

describe('parseBubbleWidgetDeepLink', () => {
  it('maps the plan widget into Journal state under HashRouter', () => {
    expect(parseBubbleWidgetDeepLink(link('/journal?section=plans'))).toEqual({
      to: '/journal',
      state: { journalContext: { section: 'plans' } },
    })
  })

  it('carries a valid Capsule recap request without trusting it as viewed', () => {
    expect(parseBubbleWidgetDeepLink(
      link('/capsule?recap=2f78821a-218e-4f15-95bb-b06749053f44&source=widget'),
    )).toEqual({
      to: '/capsule',
      state: {
        capsuleContext: {
          recapId: '2f78821a-218e-4f15-95bb-b06749053f44',
          source: 'widget',
        },
      },
    })
  })

  it('carries the exact Capsule requested by a contribution prompt', () => {
    expect(parseBubbleWidgetDeepLink(
      link('/capsule?contribute=special-demo-day'),
    )).toEqual({
      to: '/capsule',
      state: {
        capsuleContext: {
          contributionId: 'special-demo-day',
          source: 'widget',
        },
      },
    })
  })

  it('allows only the widget destinations the app supports', () => {
    expect(parseBubbleWidgetDeepLink(link('/'))).toEqual({ to: '/' })
    expect(parseBubbleWidgetDeepLink(link('/capture?mode=manual'))).toEqual({
      to: '/capture',
    })
    expect(parseBubbleWidgetDeepLink(
      link('/journal/photo/capsule-1/photo-2'),
    )).toEqual({
      to: '/journal',
      state: { journalContext: {
        section: 'people', personId: 'review-uploads', source: 'widget',
        focusMemoryId: 'capsule-capsule-1-photo-2',
        focusPhotoKey: 'photo:photo-2',
        focusPhotoId: 'photo-2', focusCollectionId: 'capsule-1',
      } },
    })
    expect(parseBubbleWidgetDeepLink(link('/settings'))).toBeNull()
  })

  it.each([
    ['family-photo-library', 'journal-photo-photo-2'],
    ['capsule-1', 'capsule-capsule-1-photo-2'],
  ])('focuses %s photos in the normal Journal timeline', (collection, memoryId) => {
    expect(parseBubbleWidgetDeepLink(
      link(`/journal?photo=photo-2&collection=${collection}&source=widget`),
    )).toEqual({
      to: '/journal',
      state: { journalContext: {
        section: 'people', personId: 'review-uploads', source: 'widget',
        focusMemoryId: memoryId,
        focusPhotoKey: collection === 'family-photo-library'
          ? 'journal-photo:photo-2' : 'photo:photo-2',
        focusPhotoId: 'photo-2', focusCollectionId: collection,
      } },
    })
  })

  it.each([
    '/journal?photo=&collection=week',
    '/journal?photo=photo',
    '/journal?collection=week',
    '/journal?photo=a&photo=b&collection=week',
    '/journal?photo=photo&collection=week&section=plans',
    '/journal?photo=photo&collection=week&source=other',
    '/journal?photo=%2Fprivate&collection=week',
    '/journal?photo=photo&collection=%2E%2E',
  ])('rejects unsafe or conflicting photo destination %s', (route) => {
    expect(parseBubbleWidgetDeepLink(link(route))).toBeNull()
  })

  it('rejects external, malformed, traversal, and unexpected-query URLs', () => {
    expect(parseBubbleWidgetDeepLink('https://example.test/open?route=%2F')).toBeNull()
    expect(parseBubbleWidgetDeepLink('com.simerfamily.kinsphere://evil?route=%2F')).toBeNull()
    expect(parseBubbleWidgetDeepLink(link('/../settings'))).toBeNull()
    expect(parseBubbleWidgetDeepLink(link('/journal?section=plans&next=https://evil.test'))).toBeNull()
    expect(parseBubbleWidgetDeepLink(link('//evil.test'))).toBeNull()
  })

  it('rejects duplicate and empty route controls instead of choosing the first value', () => {
    expect(parseBubbleWidgetDeepLink(
      link('/journal?section=plans&section=photos'),
    )).toBeNull()
    expect(parseBubbleWidgetDeepLink(
      link('/capsule?recap=first&recap=second&source=widget'),
    )).toBeNull()
    expect(parseBubbleWidgetDeepLink(
      link('/capture?mode=manual&mode=manual'),
    )).toBeNull()
    expect(parseBubbleWidgetDeepLink(
      link('/capsule?recap=&source=widget'),
    )).toBeNull()
  })
})
