import type { useGalleryScanSession } from './galleryScanSession'
import './GalleryScanStatus.css'

type GalleryScan = ReturnType<typeof useGalleryScanSession>

/** A linked library is not a finished album; expose the actual durable scan work. */
export function GalleryScanStatus({ scan }: { scan: GalleryScan }) {
  if (!scan.total) return null
  const incomplete = scan.scanned < scan.total
  const title = scan.backgroundPermissionRequired ? 'Keep checking outside Bubble'
    : scan.status === 'complete' ? 'Gallery checked'
    : scan.status === 'waiting-for-person' ? 'Ready to organize your gallery'
      : scan.status === 'needs-retry' ? 'Some photos still need checking'
        : scan.status === 'paused' ? 'Gallery checking paused'
          : scan.backgroundEnabled ? 'Checking photos in background' : 'Organizing your gallery'
  const detail = scan.backgroundPermissionRequired
    ? 'Allow a quiet progress notification to check photos while you use other apps. You can pause it at any time.'
    : scan.status === 'waiting-for-person'
    ? 'Add a person below to begin finding familiar faces in older photos.'
    : scan.status === 'complete'
      ? 'Every available photo has been checked. Strong matches appear in scrapbooks; only plausible matches are offered for optional review.'
      : scan.status === 'paused' && scan.pauseReason === 'editor'
        ? 'Adding people takes priority. Checking resumes when you close the face editor.'
        : scan.status === 'paused' && scan.pauseReason === 'background'
          ? 'Your progress is saved. Checking resumes when the app is active again.'
          : scan.backgroundEnabled
            ? 'You can use other apps or lock your phone. Progress is saved on this device; new matches appear when you return. Plug in for a long scan.'
            : 'Older photos are checked first. You can browse other tabs while Bubble is open. Albums fill in as results are saved.'
  return <section className="gallery-scan" aria-label="Gallery face matching">
    <div className="gallery-scan__heading"><strong>{title}</strong><span>{scan.scanned.toLocaleString()} / {scan.total.toLocaleString()}</span></div>
    <progress max={scan.total} value={scan.scanned} aria-label="Gallery photos checked" />
    <p>{detail}</p>
    {scan.error ? <p className="gallery-scan__warning">{scan.error}</p> : null}
    {scan.requiresRestart ? <p>Close and reopen Bubble to restart the photo checker. Saved progress will be kept.</p> : null}
    {scan.failed > 0 ? <p className="gallery-scan__warning">{scan.failed.toLocaleString()} {scan.failed === 1 ? 'photo could' : 'photos could'} not be checked. These are not counted as finished.</p> : null}
    {(incomplete || scan.status === 'needs-retry') && scan.status !== 'waiting-for-person' ? <div className="gallery-scan__actions">
      {scan.backgroundPermissionRequired ? <button type="button" onClick={scan.retry}>Enable background checking</button> : <>
        {scan.status === 'running' ? <button type="button" onClick={scan.pause}>Pause checking</button> : null}
        {scan.status === 'paused' && scan.pauseReason === 'manual' ? <button type="button" onClick={scan.resume}>Resume checking</button> : null}
        {scan.status === 'needs-retry' && !scan.requiresRestart ? <button type="button" onClick={scan.retry}>Retry unchecked photos</button> : null}
      </>}
    </div> : null}
  </section>
}
