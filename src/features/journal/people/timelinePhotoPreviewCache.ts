import { createMemberSessionCache } from '../../../app/memberSessionCache'

// Only recently displayed previews stay warm. Mounted images are never evicted;
// idle previews are bounded by both count and Blob bytes and expire after a minute.
const MAX_IDLE_PREVIEWS = 12
const MAX_IDLE_BYTES = 24 * 1024 * 1024
const IDLE_LIFETIME_MS = 60_000

type Preview = { url: string; users: number; timer?: ReturnType<typeof setTimeout> }
type PreviewSession = Map<Blob, Preview>

function removePreview(session: PreviewSession, source: Blob, preview: Preview) {
  if (session.get(source) !== preview) return
  clearTimeout(preview.timer)
  session.delete(source)
  URL.revokeObjectURL(preview.url)
}

const sessions = createMemberSessionCache<PreviewSession>({
  dispose(session) {
    for (const [source, preview] of session) removePreview(session, source, preview)
  },
})

/** Reads without allocating: warm image elements can receive src on first render. */
export function peekTimelinePhotoPreview(namespace: string, source: Blob) {
  return sessions.get(namespace)?.get(source)?.url
}

function trimIdlePreviews(session: PreviewSession) {
  const idle = [...session].filter(([, preview]) => preview.users === 0)
  let count = idle.length
  let bytes = idle.reduce((total, [source]) => total + source.size, 0)
  for (const [source, preview] of idle) {
    if (count <= MAX_IDLE_PREVIEWS && bytes <= MAX_IDLE_BYTES) break
    removePreview(session, source, preview)
    count -= 1
    bytes -= source.size
  }
}

/** Call after commit. Rail, album and timeline share one URL for the same Blob. */
export function acquireTimelinePhotoPreview(namespace: string, source: Blob) {
  let session = sessions.get(namespace)
  if (!session) {
    session = new Map()
    sessions.set(namespace, session)
  }
  const preview = session.get(source) ?? { url: URL.createObjectURL(source), users: 0 }
  clearTimeout(preview.timer)
  preview.timer = undefined
  preview.users += 1
  // Map order tracks recent use, so the oldest unused previews leave first.
  session.delete(source)
  session.set(source, preview)
  let released = false
  return {
    url: preview.url,
    release() {
      if (released) return
      released = true
      if (session.get(source) !== preview) return
      preview.users -= 1
      if (preview.users !== 0) return
      preview.timer = setTimeout(() => removePreview(session, source, preview), IDLE_LIFETIME_MS)
      trimIdlePreviews(session)
    },
  }
}
