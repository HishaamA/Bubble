import { JOURNAL_LIBRARY_ID } from '../journal/journalPhotoTypes'

export type BubbleWidgetDestination = {
  to: string
  state?: Record<string, unknown>
}

/** Validates native widget URLs before allowing them into the HashRouter. */
export function parseBubbleWidgetDeepLink(
  value: string,
): BubbleWidgetDestination | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== 'com.simerfamily.kinsphere:'
    || url.hostname !== 'open'
    || (url.pathname !== '' && url.pathname !== '/')
    || url.username
    || url.password
    || url.port
    || url.searchParams.size !== 1
    || url.searchParams.getAll('route').length !== 1
  ) return null

  const route = url.searchParams.get('route')
  if (
    !route
    || route.length > 512
    || !route.startsWith('/')
    || route.startsWith('//')
    || route.includes('\\')
    || route.includes('#')
    || /(^|\/)\.{1,2}(\/|$)/.test(route)
  ) return null

  let destination: URL
  try {
    destination = new URL(route, 'https://bubble.local')
  } catch {
    return null
  }
  if (destination.origin !== 'https://bubble.local') return null
  const params = destination.searchParams
  const pathname = destination.pathname
  if ([...new Set(params.keys())].some((key) => params.getAll(key).length !== 1)) {
    return null
  }

  if (pathname === '/' && params.size === 0) return { to: '/' }

  if (pathname === '/journal') {
    if ([...params.keys()].some((key) => !['section', 'photo', 'collection', 'source'].includes(key))) return null
    const section = params.get('section')
    if (section !== null && section !== 'plans' && section !== 'photos' && section !== 'flights') {
      return null
    }
    if (params.get('source') !== null && params.get('source') !== 'widget') return null
    if (params.has('photo') || params.has('collection')) {
      const photoId = params.get('photo')
      const collectionId = params.get('collection')
      if (
        !photoId || !collectionId
        || !safeRouteId(photoId) || !safeRouteId(collectionId)
        || (section !== null && section !== 'photos')
      ) return null
      return journalPhotoDestination(collectionId, photoId)
    }
    return section === 'plans'
      ? {
          to: '/journal',
          state: { journalContext: { section: 'plans' } },
        }
      : { to: '/journal' }
  }

  if (pathname === '/capsule') {
    if ([...params.keys()].some((key) => !['recap', 'contribute', 'source'].includes(key))) {
      return null
    }
    const recap = params.get('recap')
    const contribute = params.get('contribute')
    if (params.has('recap') && !recap) return null
    if (params.has('contribute') && !contribute) return null
    if (recap && contribute) return null
    if (recap && !safeRouteId(recap)) return null
    if (contribute && !safeRouteId(contribute)) return null
    if (params.get('source') !== null && params.get('source') !== 'widget') return null
    return recap
      ? {
          to: '/capsule',
          state: {
            capsuleContext: { recapId: recap, source: 'widget' },
          },
        }
      : contribute
        ? {
            to: '/capsule',
            state: {
              capsuleContext: { contributionId: contribute, source: 'widget' },
            },
          }
        : { to: '/capsule' }
  }

  if (pathname === '/capture') {
    if ([...params.keys()].some((key) => key !== 'mode')) return null
    const mode = params.get('mode')
    return mode === null || mode === 'manual' ? { to: '/capture' } : null
  }

  if (params.size === 0 && /^\/journal\/photo\/[^/]+\/[^/]+$/.test(pathname)) {
    const [, , , capsuleId, photoId] = pathname.split('/')
    return capsuleId && photoId && safeRouteId(capsuleId) && safeRouteId(photoId)
      ? journalPhotoDestination(capsuleId, photoId)
      : null
  }

  return null
}

/** Widget photos focus the ordinary Journal timeline, never a separate viewer. */
function journalPhotoDestination(collectionId: string, photoId: string): BubbleWidgetDestination {
  return {
    to: '/journal',
    state: {
      journalContext: {
        section: 'people',
        personId: 'review-uploads',
        focusMemoryId: collectionId === JOURNAL_LIBRARY_ID
          ? `journal-photo-${photoId}`
          : `capsule-${collectionId}-${photoId}`,
        focusPhotoKey: collectionId === JOURNAL_LIBRARY_ID
          ? `journal-photo:${photoId}`
          : `photo:${photoId}`,
        focusPhotoId: photoId,
        focusCollectionId: collectionId,
        source: 'widget',
      },
    },
  }
}

function safeRouteId(value: string) {
  return /^[a-z0-9][a-z0-9._~-]{0,159}$/i.test(value)
}
