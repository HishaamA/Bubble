import type { usePhoneGallery } from './gallery/usePhoneGallery'
import './PhoneGalleryPanel.css'

export type PhoneGalleryConnection = ReturnType<typeof usePhoneGallery>

/** One-time Journal invitation; subsequent management lives only in Settings. */
export function PhoneGalleryPanel({ gallery, mode = 'prompt' }: {
  gallery: PhoneGalleryConnection
  mode?: 'prompt' | 'settings'
}) {
  const settings = mode === 'settings'
  if (!settings && (!gallery.supported || gallery.setupComplete || gallery.enabled)) return null
  const busy = gallery.progress !== null
  const linkedCount = gallery.photos.length.toLocaleString()
  return (
    <section className={`phone-gallery${settings ? ' phone-gallery--settings' : ''}`} aria-label="Phone gallery connection">
      <div className="phone-gallery__heading">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8" cy="9" r="1.5" /><path d="m4 17 5-5 4 4 3-3 4 4" /></svg>
        <div><h2>{settings ? 'Phone gallery' : 'Bring your earlier photos into Journal'}</h2><p>{gallery.enabled
          ? gallery.ready ? `Connected · ${linkedCount} ${gallery.photos.length === 1 ? 'photo' : 'photos'}` : 'Connected · checking your photo library'
          : settings ? 'Not connected · optional' : 'A one-time connection for your family scrapbooks.'}</p></div>
      </div>
      <p className="phone-gallery__detail">{settings && gallery.enabled
        ? 'Your connection is remembered. Bubble checks quietly for changes and keeps existing face-matching progress. Originals stay in your gallery, with no duplicate copies or automatic uploads.'
        : 'Find familiar faces in photos already on your phone. Matching stays on this device; nothing is uploaded and your originals are not copied.'}</p>
      {!gallery.supported ? <p className="phone-gallery__detail">Available in the Android and iOS app. You can still add photos manually in Journal.</p> : <>
        {settings && gallery.permission === 'limited' ? <p className="phone-gallery__detail">Only selected photos are connected. You can change that selection anytime.</p> : null}
        <div className="phone-gallery__actions">
          {gallery.enabled ? <>
            <button type="button" disabled={busy} onClick={() => { void gallery.refresh() }}>Check for new photos</button>
            {gallery.permission === 'limited' ? <button type="button" disabled={busy} onClick={() => { void gallery.connect() }}>Change photo access</button> : null}
            <button type="button" className="phone-gallery__quiet" onClick={gallery.disconnect}>Disconnect</button>
          </> : <>
            <button type="button" disabled={busy} onClick={() => { void gallery.connect() }}>Connect gallery</button>
            {!settings ? <button type="button" className="phone-gallery__quiet" onClick={gallery.skipSetup}>Not now</button> : null}
            {settings && gallery.permission === 'denied' ? <button type="button" className="phone-gallery__quiet" onClick={() => { void gallery.openSettings() }}>Photo permissions</button> : null}
          </>}
        </div>
      </>}
      {!settings ? <p className="phone-gallery__hint">You can change this later in Settings → Phone gallery.</p> : null}
      {settings && gallery.enabled ? <p className="phone-gallery__hint">Face-checking progress is shown in Journal. Disconnecting removes the gallery links and their matching data, never your original photos.</p> : null}
      {settings && busy ? <p className="phone-gallery__status" role="status">Updating photo links… {gallery.progress?.loaded.toLocaleString()} checked</p> : null}
      {gallery.error ? <p className="phone-gallery__status" role="alert">{gallery.error}</p> : null}
    </section>
  )
}
