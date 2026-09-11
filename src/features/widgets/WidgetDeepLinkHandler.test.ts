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
    )).toEqual({ to: '/journal/photo/capsule-1/photo-2' })
    expect(parseBubbleWidgetDeepLink(link('/settings'))).toBeNull()
  })

  it('rejects external, malformed, traversal, and unexpected-query URLs', () => {
    expect(parseBubbleWidgetDeepLink('https://example.test/open?route=%2F')).toBeNull()
    expect(parseBubbleWidgetDeepLink('com.simerfamily.kinsphere://evil?route=%2F')).toBeNull()
    expect(parseBubbleWidgetDeepLink(link('/../settings'))).toBeNull()
    expect(parseBubbleWidgetDeepLink(link('/journal?section=plans&next=https://evil.test'))).toBeNull()
    expect(parseBubbleWidgetDeepLink(link('//evil.test'))).toBeNull()
  })
})
