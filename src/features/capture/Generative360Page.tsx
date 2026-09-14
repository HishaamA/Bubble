import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { processCapsuleImage } from '../capsules/processCapsuleImage'
import { downloadGeneration, getGenerationHealth, getGenerationJob, startGeneration } from '../../services/media/generativePanorama'
import { withAiPanoramaDisclosure } from '../../services/media/panoramaProvenance'
import { estimateReferenceFieldOfView } from '../../services/media/referenceFieldOfView'
import type { Capture360Submission } from './Capture360Page'
import { GuidedPanoramaReview } from './GuidedPanoramaReview'
import {
  createGenerativeCaptureStore,
  type GenerativeCaptureDraft,
  type GenerativeCaptureStore,
  type GenerationReferencePhoto,
} from './generativeCaptureStore'
import './Generative360Page.css'

type GenerationHealth = Awaited<ReturnType<typeof getGenerationHealth>>
type Props = {
  captureOwnerKey: string
  onClose: () => void
  onLegacyCapture: () => void
  onViewMemories: () => void
  onSave: (submission: Capture360Submission) => Promise<void>
  store?: GenerativeCaptureStore
  preparePhoto?: typeof processCapsuleImage
  pollIntervalMs?: number
}

function makeId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  // getRandomValues is also available in mobile LAN previews where randomUUID
  // is restricted to secure contexts. Preserve the server's UUID contract.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function messageFor(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Your saved photos are kept.' }
function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError' }
function responseStatus(error: unknown) { return error instanceof Error && 'status' in error ? error.status : undefined }
function pageIsVisible() { return document.visibilityState !== 'hidden' }
function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = blob ? URL.createObjectURL(blob) : ''
    // oxlint-disable-next-line react/set-state-in-effect -- Object URLs are external resources owned by this effect.
    setUrl(next)
    return () => { if (next) URL.revokeObjectURL(next) }
  }, [blob])
  return url
}
function ReferencePhoto({ photo, index, disabled, onRemove, onDirection }: {
  photo: GenerationReferencePhoto; index: number; disabled: boolean; onRemove: () => void; onDirection: (azimuth: number) => void
}) {
  const url = useBlobUrl(photo.thumbnail)
  return <li className="generate-photo">
    {url ? <img src={url} alt={`Reference photo ${index + 1}`} /> : null}
    <span>Photo {index + 1}</span>
    <select aria-label={`Direction for reference photo ${index + 1}`} value={photo.azimuth} disabled={disabled} onChange={(event) => onDirection(Number(event.target.value))}>
      <option value={0}>Front</option><option value={90}>Right</option><option value={180}>Back</option><option value={270}>Left</option>
    </select>
    <button type="button" disabled={disabled} onClick={onRemove} aria-label={`Remove reference photo ${index + 1}`}>×</button>
  </li>
}

/** Photo drafts, local generation jobs, result recovery, and explicit saving are separate steps. */
export function Generative360Page({ captureOwnerKey, onClose, onLegacyCapture, onViewMemories, onSave,
  store: suppliedStore, preparePhoto = processCapsuleImage, pollIntervalMs = 5000 }: Props) {
  const store = useMemo(() => suppliedStore ?? createGenerativeCaptureStore(captureOwnerKey), [captureOwnerKey, suppliedStore])
  const [drafts, setDrafts] = useState<GenerativeCaptureDraft[]>([])
  const [draft, setDraft] = useState<GenerativeCaptureDraft | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preparingPhotos, setPreparingPhotos] = useState(false)
  const [health, setHealth] = useState<GenerationHealth | null>(null)
  const [healthError, setHealthError] = useState('')
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [missingJobId, setMissingJobId] = useState<string | null>(null)
  const [consent, setConsent] = useState(false)
  const [reviewing, setReviewing] = useState(true)
  const [saved, setSaved] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [caption, setCaption] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [removeDraft, setRemoveDraft] = useState<GenerativeCaptureDraft | null>(null)
  const mounted = useRef(false)
  const currentOwner = useRef(captureOwnerKey)
  useLayoutEffect(() => { currentOwner.current = captureOwnerKey }, [captureOwnerKey])
  const draftRef = useRef<GenerativeCaptureDraft | null>(null)
  const busyRef = useRef(false)
  const writeQueue = useRef<Promise<void>>(Promise.resolve())
  const actionAbort = useRef<AbortController | null>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const libraryInput = useRef<HTMLInputElement>(null)
  const displayedDraft = draft?.ownerKey === captureOwnerKey ? draft : null
  const previewUrl = useBlobUrl(displayedDraft?.result?.file)
  const jobActive = Boolean(displayedDraft?.job && !displayedDraft.result && displayedDraft.job.status !== 'failed')
  const recoveredJobId = displayedDraft?.job?.id
  const recoveredJobStatus = displayedDraft?.job?.status
  const recoveredDraftId = displayedDraft?.id
  const hasResult = Boolean(displayedDraft?.result)
  const canResend = Boolean(missingJobId && recoveredJobId === missingJobId && jobActive)
  const reportedHealthReason = health?.reason || healthError
  const healthReason = reportedHealthReason && /\b50[23]\b|could not reach|connect this app/i.test(reportedHealthReason)
    ? 'Your generation computer is not ready or connected. Start its local generation service, then check again.'
    : reportedHealthReason
  const inputsLocked = loading || busy || jobActive || Boolean(displayedDraft?.result)

  const isCurrent = useCallback(() => mounted.current && currentOwner.current === captureOwnerKey, [captureOwnerKey])
  const install = useCallback((next: GenerativeCaptureDraft | null) => {
    draftRef.current = next
    setDraft(next)
    setPrompt(next?.prompt ?? '')
    setCaption(next?.caption ?? '')
    setConsent(false)
    setReviewing(true)
    setSaved(Boolean(next?.savedMomentId))
    setError('')
    setStatusError('')
    setMissingJobId(null)
  }, [])
  const commit = useCallback(async (next: GenerativeCaptureDraft) => {
    const previous = draftRef.current?.id === next.id ? draftRef.current : null
    // Keep the latest logical edit immediately; slower writes must not erase a
    // newer annotation/title. Rendering still waits for durable transaction success.
    if (draftRef.current?.id === next.id) draftRef.current = next
    const operation = writeQueue.current.catch(() => undefined).then(() => store.save(next))
    writeQueue.current = operation
    try { await operation } catch (reason) {
      if (isCurrent() && draftRef.current === next && previous && next.photos !== previous.photos
        && next.job === previous.job && next.result === previous.result) {
        // A failed photo edit must not become a hidden future upload. Keep the
        // exact pending photo selection visible, with no claim it is durable.
        setDraft(next)
        throw new Error(`Your latest photo changes are shown but are not saved yet. ${messageFor(reason)}`)
      }
      throw reason
    }
    if (!isCurrent()) return
    setDrafts((current) => [next, ...current.filter((item) => item.id !== next.id)])
    if (draftRef.current === next) {
      setDraft(next)
    }
  }, [isCurrent, store])

  useEffect(() => {
    mounted.current = true
    let alive = true
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- Hydrates the account's external durable storage.
    setLoading(true)
    setBusy(false)
    setPreparingPhotos(false)
    busyRef.current = false
    writeQueue.current = Promise.resolve()
    setHealth(null)
    setHealthError('')
    install(null)
    void store.list().then((items) => {
      if (!alive || !isCurrent()) return
      setDrafts(items)
      install(items.find((item) => !item.savedMomentId) ?? null)
    }).catch((reason) => { if (alive && isCurrent()) setError(messageFor(reason)) })
      .finally(() => { if (alive && isCurrent()) setLoading(false) })
    void getGenerationHealth({ signal: controller.signal }).then((value) => {
      if (alive && isCurrent()) { setHealth(value); setHealthError('') }
    }).catch((reason) => { if (alive && isCurrent() && !isAbort(reason)) setHealthError(messageFor(reason)) })
    return () => {
      alive = false
      mounted.current = false
      controller.abort()
      actionAbort.current?.abort()
    }
  }, [install, isCurrent, store])

  useEffect(() => {
    if (!recoveredJobId || !recoveredDraftId || hasResult || recoveredJobStatus === 'failed' || busy) return
    const draftId = recoveredDraftId
    const jobId = recoveredJobId
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let running = false
    let stopped = false
    function current() { return alive && isCurrent() && draftRef.current?.id === draftId && draftRef.current.job?.id === jobId }
    async function check() {
      if (!current() || running || stopped || !pageIsVisible()) return
      running = true
      controller = new AbortController()
      const signal = controller.signal
      try {
        const job = await getGenerationJob(jobId, { signal })
        if (!current() || signal.aborted) return
        if (job.id !== jobId) throw new Error('The generation service returned a different scene. Your draft is kept.')
        const next = { ...draftRef.current!, job, updatedAt: new Date().toISOString() }
        await commit(next)
        if (!current() || signal.aborted) return
        setStatusError('')
        setMissingJobId(null)
        if (job.status === 'completed') {
          const result = await downloadGeneration(jobId, { signal })
          if (!current() || signal.aborted) return
          const completed: GenerativeCaptureDraft = { ...draftRef.current!, result: {
            file: result.file, width: result.width, height: result.height,
            provenance: { kind: 'ai-reconstruction', provider: 'local',
              model: job.model ?? next.generationModel ?? health?.model ?? 'Local generation model',
              referenceCount: next.photos.length, generatedAt: job.generatedAt ?? new Date().toISOString() },
          }, updatedAt: new Date().toISOString() }
          // Do not expose a review that would vanish on restart if storage fails.
          await commit(completed)
          if (current()) setReviewing(true)
          stopped = true
        } else if (job.status === 'failed' || job.status === 'submission-unknown') {
          stopped = true
        }
      } catch (reason) {
        if (current() && !isAbort(reason)) {
          stopped = true
          if (responseStatus(reason) === 404) {
            setMissingJobId(jobId)
            setConsent(false)
            setStatusError('Your generation computer has no record of this request. You can send the same saved request again; it will keep the same job ID.')
          } else setStatusError(`${messageFor(reason)} Checking has paused; the job may still be running on your generation computer. Your local photos are kept.`)
        }
      } finally {
        running = false
        if (current() && !stopped && pageIsVisible()) timer = setTimeout(() => void check(), pollIntervalMs)
      }
    }
    function visibilityChanged() {
      if (!pageIsVisible()) {
        clearTimeout(timer)
        controller?.abort()
      } else { stopped = false; void check() }
    }
    void check()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => { alive = false; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibilityChanged) }
  }, [recoveredDraftId, recoveredJobId, recoveredJobStatus, hasResult,
    busy, commit, health?.model, isCurrent, pollIntervalMs, refresh])

  function newDraft(): GenerativeCaptureDraft {
    const now = new Date().toISOString()
    return { version: 1, id: makeId(), ownerKey: captureOwnerKey, createdAt: now, updatedAt: now,
      photos: [], prompt: '', caption: '', annotations: [] }
  }
  function snapshot(): GenerativeCaptureDraft {
    return { ...(draftRef.current ?? newDraft()), prompt, caption, updatedAt: new Date().toISOString() }
  }
  function lock() { if (busyRef.current || loading) return false; busyRef.current = true; setBusy(true); setError(''); return true }
  function unlock() { if (isCurrent()) { busyRef.current = false; setBusy(false) } }
  async function keepEdits() {
    if (!draftRef.current || inputsLocked) return
    try { await commit(snapshot()) } catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
  }
  async function openPicker(origin: 'camera' | 'library') {
    if (inputsLocked || !lock()) return
    try {
      const next = snapshot()
      if (!draftRef.current) { draftRef.current = next; setDraft(next) }
      // External camera apps can recreate the WebView. Commit all previous inputs first.
      await commit(next)
      if (isCurrent()) (origin === 'camera' ? cameraInput : libraryInput).current?.click()
    } catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { unlock() }
  }
  async function selectPhotos(event: ChangeEvent<HTMLInputElement>, origin: 'camera' | 'library') {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!files.length || inputsLocked || !lock()) return
    setPreparingPhotos(true)
    try {
      const next = snapshot()
      if (next.photos.length + files.length > 4) throw new Error(`Choose up to ${4 - next.photos.length} more photos. A scene uses at most four.`)
      const additions: GenerationReferencePhoto[] = []
      for (const file of files) {
        const prepared = await preparePhoto(file)
        if (!isCurrent()) return
        // Read only local originals; normalized dimensions already include EXIF orientation.
        const fieldOfView = await estimateReferenceFieldOfView(file, { width: prepared.width, height: prepared.height })
        if (!isCurrent()) return
        const usedDirections = new Set([...next.photos, ...additions].map((item) => item.azimuth))
        additions.push({ id: makeId(), name: file.name, original: file, image: prepared.image,
          thumbnail: prepared.thumbnail, width: prepared.width, height: prepared.height, origin,
          azimuth: [0, 90, 180, 270].find((direction) => !usedDirections.has(direction)) ?? 0, fieldOfView })
      }
      const updated = { ...next, photos: [...next.photos, ...additions] }
      if (!draftRef.current) { draftRef.current = updated; setDraft(updated) }
      await commit(updated)
    } catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { if (isCurrent()) setPreparingPhotos(false); unlock() }
  }
  async function removePhoto(id: string) {
    if (inputsLocked || !draftRef.current || !lock()) return
    try { await commit({ ...snapshot(), photos: draftRef.current.photos.filter((photo) => photo.id !== id) }) }
    catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { unlock() }
  }
  async function setDirection(id: string, azimuth: number) {
    if (inputsLocked || !draftRef.current || !lock()) return
    try { await commit({ ...snapshot(), photos: draftRef.current.photos.map((photo) => photo.id === id ? { ...photo, azimuth } : photo) }) }
    catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { unlock() }
  }
  async function generate(resend = false) {
    if (!health?.ready || !consent || !draftRef.current?.photos.length || (jobActive && !(resend && canResend)) || !lock()) return
    const controller = new AbortController()
    actionAbort.current = controller
    try {
      const jobId = resend && canResend ? draftRef.current!.job!.id : makeId()
      const selected = snapshot()
      const photos: GenerationReferencePhoto[] = []
      for (const photo of selected.photos) {
        // Older drafts remain untouched until the user explicitly generates.
        // Missing EXIF falls back to the prepared image's upright aspect ratio.
        const fieldOfView = photo.fieldOfView ?? await estimateReferenceFieldOfView(photo.original, { width: photo.width, height: photo.height })
        if (!isCurrent() || controller.signal.aborted) return
        photos.push({ ...photo, fieldOfView: { ...fieldOfView } })
      }
      const next: GenerativeCaptureDraft = { ...selected, photos, generationModel: health.model,
        job: { id: jobId, status: 'submission-unknown', stage: 'Sending your photos' } }
      await commit(next)
      if (!isCurrent()) return
      const job = await startGeneration({ id: jobId,
        files: next.photos.map((photo, index) => new File([photo.image], `reference-${index + 1}.jpg`, { type: 'image/jpeg' })),
        prompt: next.prompt.trim(), azimuths: next.photos.map((photo) => photo.azimuth),
        horizontalFovs: next.photos.map((photo) => photo.fieldOfView!.horizontalFovDegrees), consent: true, signal: controller.signal })
      if (!isCurrent() || controller.signal.aborted) return
      if (job.id !== jobId) throw new Error('The generation service returned a different scene. Check this draft’s status before trying again.')
      await commit({ ...next, job, updatedAt: new Date().toISOString() })
      setConsent(false)
      setMissingJobId(null)
    } catch (reason) {
      if (isCurrent() && !isAbort(reason)) {
        if ([400, 401, 403, 409, 413, 415, 422, 503].includes(Number(responseStatus(reason))) && draftRef.current?.job) {
          try { await commit({ ...draftRef.current, job: { ...draftRef.current.job, status: 'failed', stage: 'Request not accepted', error: messageFor(reason) } }) }
          catch (storageError) { if (isCurrent()) setError(messageFor(storageError)) }
        }
        if (isCurrent()) setStatusError(`${messageFor(reason)} Your draft is kept. Check status before making another request.`)
      }
    } finally { if (actionAbort.current === controller) actionAbort.current = null; unlock() }
  }
  async function refreshHealth() {
    if (checkingHealth || busyRef.current) return
    const controller = new AbortController()
    actionAbort.current = controller
    setCheckingHealth(true)
    try {
      const value = await getGenerationHealth({ signal: controller.signal })
      if (isCurrent() && !controller.signal.aborted) { setHealth(value); setHealthError('') }
    } catch (reason) { if (isCurrent() && !isAbort(reason)) setHealthError(messageFor(reason)) }
    finally {
      if (actionAbort.current === controller) actionAbort.current = null
      if (isCurrent()) setCheckingHealth(false)
    }
  }
  async function saveScene() {
    if (!draftRef.current?.result || !lock()) return
    try {
      await writeQueue.current
      if (!isCurrent()) return
      const next = snapshot()
      await commit(next)
      if (!isCurrent()) return
      const result = next.result!
      await onSave({ id: next.id, file: new File([result.file], result.file.type === 'image/png' ? 'ai-360-scene.png' : 'ai-360-scene.jpg', { type: result.file.type || 'image/jpeg' }),
        width: result.width, height: result.height, createdAt: new Date(next.createdAt), source: 'manual',
        caption: withAiPanoramaDisclosure(next.caption.trim(), result.provenance), annotations: next.annotations, provenance: result.provenance })
      // Same moment id makes retry safe if local bookkeeping fails after the moment save.
      await commit({ ...next, savedMomentId: next.id, updatedAt: new Date().toISOString() })
      if (isCurrent()) setSaved(true)
    } catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { unlock() }
  }
  async function tryAnotherVersion() {
    if (!draftRef.current?.result || !lock()) return
    try {
      await writeQueue.current
      if (!isCurrent()) return
      const original = snapshot()
      await commit(original)
      if (!isCurrent()) return
      const next: GenerativeCaptureDraft = { ...newDraft(), prompt: original.prompt,
        photos: original.photos.map((photo) => ({ ...photo, fieldOfView: photo.fieldOfView ? { ...photo.fieldOfView } : undefined })) }
      // This is a separate retained draft, not a retry that overwrites the old scene.
      await commit(next)
      if (isCurrent()) install(next)
    } catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { unlock() }
  }
  async function leave(callback: () => void) {
    if (busyRef.current) { callback(); return }
    try { if (draftRef.current) await commit(snapshot()); if (isCurrent()) callback() }
    catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
  }
  async function deleteDraft() {
    if (!removeDraft || !lock()) return
    try {
      await writeQueue.current.catch(() => undefined)
      if (!isCurrent()) return
      await store.remove(removeDraft.id)
      if (!isCurrent()) return
      setDrafts((items) => items.filter((item) => item.id !== removeDraft.id))
      if (draftRef.current?.id === removeDraft.id) install(null)
      setRemoveDraft(null)
    } catch (reason) { if (isCurrent()) setError(messageFor(reason)) }
    finally { unlock() }
  }

  return <section className="ks-feature generate-page" aria-labelledby="generate-title">
    <header className="generate-header">
      <div><p className="generate-eyebrow">A little imagination, all around you</p><h1 id="generate-title">Create a 360° scene</h1></div>
      <button className="generate-close" type="button" aria-label="Close scene creator" disabled={preparingPhotos} onClick={() => void leave(onClose)}>×</button>
    </header>
    <p className="generate-intro">Start with a few photos of a place. AI imagines the space between them, so you can look around a new scene.</p>
    {error ? <p className="generate-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">Opening your saved photo drafts…</p> : null}
    {preparingPhotos ? <p role="status">Preparing and saving your photos on this device…</p> : null}
    {saved && displayedDraft?.result ? <div className="generate-card generate-success">
      <span className="generate-badge">AI reconstruction</span><h2>Saved to Moments</h2>
      <p>Your scene is saved on this device. Its original photos are still in this draft.</p>
      <button className="ks-primary-button" type="button" onClick={onViewMemories}>View in Moments</button>
      <button className="ks-secondary-button" type="button" disabled={busy} onClick={() => void tryAnotherVersion()}>Try another version</button>
      <button className="ks-secondary-button" type="button" disabled={busy} onClick={() => install(null)}>Create another scene</button>
    </div> : displayedDraft?.result && previewUrl ? <div className="generate-result">
      <p className="generate-disclosure"><span className="generate-badge">AI reconstruction</span> Includes imagined details. It is not a photographic record of the whole place.</p>
      {reviewing ? <GuidedPanoramaReview panoramaUrl={previewUrl} annotations={displayedDraft.annotations}
        onAnnotationsChange={(annotations) => {
          if (!draftRef.current) return
          void commit({ ...snapshot(), annotations }).catch((reason) => { if (isCurrent()) setError(messageFor(reason)) })
        }} onContinue={() => setReviewing(false)} onRetake={() => install(null)} hideRetake
        title="Look around your AI scene" subtitle="Drag to look around. Check the invented details before saving."
        continueLabel="Add a title" busy={busy} /> : <div className="generate-card">
        <img className="generate-result-preview" src={previewUrl} alt="AI-generated 360 scene preview" />
        <label htmlFor="generate-caption">Moment title <span>(optional)</span></label>
        <textarea id="generate-caption" maxLength={160} value={caption} disabled={busy} placeholder="A place to remember" onChange={(event) => setCaption(event.target.value)} />
        <p className="generate-fineprint">Saved with an AI disclosure. Your photos and generated scene stay in this draft.</p>
        <div className="generate-actions"><button className="ks-secondary-button" type="button" disabled={busy} onClick={() => setReviewing(true)}>Look around again</button>
          <button className="ks-primary-button" type="button" disabled={busy} onClick={() => void saveScene()}>{busy ? 'Saving…' : 'Save to Moments'}</button></div>
      </div>}
      <div className="generate-version"><button className="ks-secondary-button" type="button" disabled={busy} onClick={() => void tryAnotherVersion()}>Try another version</button>
        <p className="generate-fineprint">Reuse these photos in a new draft. This version is kept, and nothing generates until you choose to start.</p></div>
    </div> : <div className="generate-card">
      <ol className="generate-steps" aria-label="Create your scene"><li><span>1</span> Add photos</li><li><span>2</span> Let AI imagine</li><li><span>3</span> Review & save</li></ol>
      <h2>Your view of the place</h2>
      <p>Add 1–4 ordinary photos. Use the main 1× camera and keep the phone level. Stay in one spot and turn toward the front, right, back, and left. Set each photo’s direction below. No dots to follow.</p>
      {displayedDraft?.photos.length ? <ol className="generate-photos" aria-label="Your reference photos">{displayedDraft.photos.map((photo, index) =>
        <ReferencePhoto key={photo.id} photo={photo} index={index} disabled={inputsLocked} onRemove={() => void removePhoto(photo.id)} onDirection={(azimuth) => void setDirection(photo.id, azimuth)} />)}</ol>
        : <div className="generate-photo-placeholder" aria-hidden="true"><span>＋</span><p>A few glimpses. A whole new view.</p></div>}
      <div className="generate-actions">
        <button className="ks-primary-button" type="button" disabled={inputsLocked || displayedDraft?.photos.length === 4} onClick={() => void openPicker('camera')}>Take a photo</button>
        <button className="ks-secondary-button" type="button" disabled={inputsLocked || displayedDraft?.photos.length === 4} onClick={() => void openPicker('library')}>Choose photos</button>
      </div>
      <p className="generate-fineprint">{displayedDraft?.photos.length ?? 0} of 4 photos · Original photos stay on this device.</p>
      <label htmlFor="generate-prompt">Tell us about this place <span>(optional)</span></label>
      <textarea id="generate-prompt" maxLength={1200} value={prompt} disabled={inputsLocked} placeholder="A sunlit garden, with the old olive tree just behind me…" onChange={(event) => setPrompt(event.target.value)} onBlur={() => void keepEdits()} />
      <div className="generate-provider">
        <span className="generate-badge">AI · Your generation computer</span>
        <p>AI creates a new 360° scene, including things you did not photograph. Photos may be changed or reimagined.</p>
        {!health?.ready ? <><p role="status">{healthReason || 'Checking your generation computer…'} Your photos can still be prepared and kept here.</p>
          <button className="ks-secondary-button" type="button" disabled={busy || checkingHealth} onClick={() => void refreshHealth()}>{checkingHealth ? 'Checking connection…' : 'Check connection'}</button></>
          : <p className="generate-fineprint">Powered by {health.model}. Keep this phone connected to your generation computer.</p>}
        {!jobActive || canResend ? <label className="generate-consent"><input type="checkbox" checked={consent} disabled={busy || !health?.ready} onChange={(event) => setConsent(event.target.checked)} />
          <span>Send these photos and this description to my generation computer. I understand that AI creates imagined details.</span></label> : null}
      </div>
      {displayedDraft?.job && !displayedDraft.result ? <div className="generate-job" role="status" aria-live="polite">
        <h3>{displayedDraft.job.status === 'failed' ? 'The scene could not be created' : displayedDraft.job.status === 'submission-unknown' ? 'Checking your request' : 'Creating your scene'}</h3>
        <p>{displayedDraft.job.error || displayedDraft.job.stage}</p>
        <p className="generate-fineprint">You can leave this page. A submitted job keeps running on your generation computer; return here to check it. Your photos are saved.</p>
      </div> : null}
      {statusError ? <p className="generate-error" role="status">{statusError}</p> : null}
      {jobActive ? <button className="ks-secondary-button" type="button" disabled={busy} onClick={() => { setStatusError(''); setRefresh((value) => value + 1) }}>Check status</button>
        : <button className="ks-primary-button generate-submit" type="button" disabled={busy || loading || !health?.ready || !consent || !displayedDraft?.photos.length} onClick={() => void generate()}>
          {busy ? 'Preparing your scene…' : displayedDraft?.job?.status === 'failed' ? 'Try a new generation' : 'Generate my 360° scene'}</button>}
      {canResend ? <button className="ks-primary-button generate-submit" type="button" disabled={busy || !consent || !health?.ready} onClick={() => void generate(true)}>Send saved request again</button> : null}
      {displayedDraft?.job?.status === 'failed' ? <p className="generate-fineprint">Trying again sends a new generation request. It never happens automatically.</p> : null}
    </div>}
    {drafts.filter((item) => item.ownerKey === captureOwnerKey).length ? <details className="generate-drafts"><summary>Photo drafts on this device ({drafts.length})</summary>
      <p>Kept separately from Moments. Removing a draft never removes a saved Moment or cancels a generation job.</p>
      {drafts.filter((item) => item.ownerKey === captureOwnerKey).map((item) => <div className="generate-draft-row" key={item.id}>
        <div><strong>{item.caption || `${item.photos.length} photo scene`}</strong><small>{new Date(item.createdAt).toLocaleDateString()} · {item.savedMomentId ? 'Saved to Moments' : item.result ? 'Ready to review' : item.job?.status ?? 'Photos saved'}</small></div>
        <button type="button" disabled={busy || loading} onClick={() => void leave(() => install(draftRef.current?.id === item.id ? draftRef.current : item))}>Open</button>
        <button type="button" disabled={busy || loading || Boolean(item.job && !item.result && item.job.status !== 'failed')} onClick={() => setRemoveDraft(item)}>Remove</button>
      </div>)}
      <button className="ks-secondary-button" type="button" disabled={busy || loading} onClick={() => void leave(() => install(null))}>Start another photo draft</button>
    </details> : null}
    {removeDraft ? <div className="generate-card" role="alertdialog" aria-labelledby="remove-scene-title" aria-describedby="remove-scene-description">
      <h2 id="remove-scene-title">Remove this local draft?</h2><p id="remove-scene-description">This draft’s stored photos and generated preview will be permanently removed. Other copies in your photo library and any scene already saved to Moments are kept.</p>
      <div className="generate-actions"><button className="ks-secondary-button" type="button" disabled={busy} onClick={() => setRemoveDraft(null)}>Keep draft</button><button className="ks-secondary-button" type="button" disabled={busy} onClick={() => void deleteDraft()}>Permanently remove draft</button></div>
    </div> : null}
    <button className="generate-legacy" type="button" disabled={busy} onClick={() => void leave(onLegacyCapture)}>Previous 360 captures & finished panoramas</button>
    <input className="generate-file-input" ref={cameraInput} type="file" accept="image/*" capture="environment" aria-label="Take a reference photo" onChange={(event) => void selectPhotos(event, 'camera')} />
    <input className="generate-file-input" ref={libraryInput} type="file" accept="image/*" multiple aria-label="Choose reference photos" onChange={(event) => void selectPhotos(event, 'library')} />
  </section>
}
