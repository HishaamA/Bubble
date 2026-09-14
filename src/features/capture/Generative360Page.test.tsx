import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Generative360Page } from './Generative360Page'
import { createMemoryGenerativeCaptureStore, type GenerativeCaptureDraft, type GenerativeCaptureStore } from './generativeCaptureStore'
import type { GuidedPanoramaReviewProps } from './GuidedPanoramaReview'
import type { Capture360Submission } from './Capture360Page'

const api = vi.hoisted(() => ({ health: vi.fn(), start: vi.fn(), job: vi.fn(), download: vi.fn(), estimateFov: vi.fn() }))
vi.mock('../../services/media/generativePanorama', () => ({ getGenerationHealth: api.health,
  startGeneration: api.start, getGenerationJob: api.job, downloadGeneration: api.download }))
vi.mock('../../services/media/referenceFieldOfView', () => ({ estimateReferenceFieldOfView: api.estimateFov }))
vi.mock('./GuidedPanoramaReview', () => ({ GuidedPanoramaReview: (props: GuidedPanoramaReviewProps) =>
  <section><h2>{props.title}</h2><button onClick={() => props.onAnnotationsChange([{ id: 'point-one', kind: 'text', pitch: 0, yaw: 10, message: 'Look here' }])}>Add a point</button><button onClick={props.onContinue}>{props.continueLabel}</button></section> }))

const photo = new File(['original photograph'], 'room.jpg', { type: 'image/jpeg' })
const prepared = { image: new Blob(['normalized reference'], { type: 'image/jpeg' }),
  thumbnail: new Blob(['thumbnail'], { type: 'image/jpeg' }), width: 1600, height: 1200, thumbnailWidth: 560, thumbnailHeight: 420 }
function pendingDraft(ownerKey = 'clerk:one'): GenerativeCaptureDraft {
  return { version: 1, id: 'saved-draft', ownerKey, createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:00Z',
    photos: [{ id: 'photo-one', name: 'room.jpg', original: photo, image: prepared.image, thumbnail: prepared.thumbnail,
      width: 1600, height: 1200, origin: 'camera', azimuth: 0 }], prompt: 'My room', caption: '', annotations: [],
    generationModel: 'local-model-v1', job: { id: 'saved-job', status: 'running', stage: 'Imagining the room' } }
}
function setup(store: GenerativeCaptureStore = createMemoryGenerativeCaptureStore('clerk:one'), ownerKey = 'clerk:one') {
  const onSave = vi.fn(async (_submission: Capture360Submission) => undefined)
  const props = { captureOwnerKey: ownerKey, store, onSave, onClose: vi.fn(), onLegacyCapture: vi.fn(), onViewMemories: vi.fn(),
    preparePhoto: vi.fn(async () => prepared), pollIntervalMs: 20 }
  return { ...render(<Generative360Page {...props} />), props, store, onSave }
}
async function addPhoto() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
  await userEvent.upload(screen.getByLabelText('Choose reference photos'), photo)
  await screen.findByAltText('Reference photo 1')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:scene') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  api.health.mockResolvedValue({ ready: true, provider: 'local', model: 'local-model-v1', maxPhotos: 4 })
  api.start.mockImplementation(async ({ id }) => ({ id, status: 'running', stage: 'Imagining the room' }))
  api.job.mockImplementation(async (id) => ({ id, status: 'running', stage: 'Imagining the room' }))
  api.download.mockResolvedValue({ file: new File(['sphere'], 'result.jpg', { type: 'image/jpeg' }), width: 2048, height: 1024 })
  api.estimateFov.mockReset().mockResolvedValue({ horizontalFovDegrees: 72, source: 'diagonal-fallback', estimated: true })
})
afterEach(() => vi.unstubAllGlobals())

describe('generative scene capture', () => {
  it('keeps ordinary photos locally while the free local model is not configured', async () => {
    api.health.mockResolvedValue({ ready: false, provider: 'local', model: 'local-model', maxPhotos: 4, reason: 'Set up the model on your computer.' })
    const { store } = setup()
    await addPhoto()
    expect(screen.getByText(/set up the model on your computer/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate my 360° scene' })).toBeDisabled()
    const saved = (await store.list())[0]
    expect(saved.photos[0].original).toBe(photo)
    expect(saved.photos[0].image).toBe(prepared.image)
    expect(saved.photos[0].azimuth).toBe(0)
    expect(saved.photos[0].fieldOfView).toEqual({ horizontalFovDegrees: 72, source: 'diagonal-fallback', estimated: true })
    expect(api.estimateFov).toHaveBeenCalledWith(photo, { width: 1600, height: 1200 })
    expect(api.start).not.toHaveBeenCalled()
    expect(api.download).not.toHaveBeenCalled()
  })
  it('requires consent, persists the job id before sending, and saves only after review and explicit action', async () => {
    const { store, onSave } = setup()
    await addPhoto()
    await userEvent.selectOptions(screen.getByLabelText('Direction for reference photo 1'), '90')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate my 360° scene' })).toBeDisabled())
    api.start.mockImplementation(async ({ id }) => {
      const saved = (await store.list())[0]
      expect(saved.job).toEqual({ id, status: 'submission-unknown', stage: 'Sending your photos' })
      expect(saved.photos).toHaveLength(1)
      return { id, status: 'completed', stage: 'Done' }
    })
    api.job.mockImplementation(async (id) => ({ id, status: 'completed', stage: 'Done' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await screen.findByRole('heading', { name: 'Look around your AI scene' })
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.start.mock.calls[0][0]).toEqual(expect.objectContaining({ azimuths: [90], horizontalFovs: [72], consent: true }))
    expect(api.estimateFov).toHaveBeenCalledTimes(1)
    expect((await store.list())[0].result?.file).toBeInstanceOf(Blob)
    expect(onSave).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Add a title' }))
    await userEvent.type(screen.getByRole('textbox', { name: /moment title/i }), 'My favourite room')
    await userEvent.click(screen.getByRole('button', { name: 'Save to Moments' }))
    await screen.findByRole('heading', { name: 'Saved to Moments' })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]).toEqual([expect.objectContaining({ source: 'manual',
      caption: 'My favourite room\n\nAI reconstruction. Includes imagined details.',
      provenance: expect.objectContaining({ provider: 'local', model: 'local-model-v1', referenceCount: 1 }) })])
    expect((await store.list())[0].photos[0].original).toBe(photo)
  })
  it('never sends a generation request when persisting its job fails', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    const save = vi.spyOn(store, 'save')
    setup(store)
    await addPhoto()
    save.mockRejectedValueOnce(new Error('Storage is full'))
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await screen.findByText(/storage is full/i)
    expect(api.start).not.toHaveBeenCalled()
    expect((await store.list())[0].photos).toHaveLength(1)
  })
  it('recovers a completed result without starting another generation or automatically saving to Moments', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    api.job.mockResolvedValue({ id: 'saved-job', status: 'completed', stage: 'Done' })
    const { onSave } = setup(store)
    await screen.findByRole('heading', { name: 'Look around your AI scene' })
    expect(api.start).not.toHaveBeenCalled()
    expect(api.download).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
    expect((await store.list())[0].result?.provenance.model).toBe('local-model-v1')
    expect(api.estimateFov).not.toHaveBeenCalled()
  })
  it('refreshes a recovered running job, shows terminal failure, and stops polling', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    api.job.mockResolvedValue({ id: 'saved-job', status: 'failed', stage: 'Failed', error: 'The model ran out of memory.' })
    setup(store)
    await screen.findByRole('heading', { name: 'The scene could not be created' })
    await new Promise((resolve) => setTimeout(resolve, 65))
    expect(api.job).toHaveBeenCalledTimes(1)
    expect(api.start).not.toHaveBeenCalled()
    expect((await store.list())[0].photos).toHaveLength(1)
  })
  it('pauses status checking after a timeout without implying the remote process stopped', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    api.job.mockRejectedValue(new Error('The service took too long to respond.'))
    setup(store)
    await screen.findByText(/job may still be running on your generation computer/i)
    await new Promise((resolve) => setTimeout(resolve, 65))
    expect(api.job).toHaveBeenCalledTimes(1)
    api.job.mockResolvedValue({ id: 'saved-job', status: 'failed', stage: 'Failed', error: 'Generation stopped on the computer.' })
    await userEvent.click(screen.getByRole('button', { name: 'Check status' }))
    await screen.findByRole('heading', { name: 'The scene could not be created' })
    expect(api.job).toHaveBeenCalledTimes(2)
    expect(api.start).not.toHaveBeenCalled()
  })
  it('ignores late results after account change and keeps recovery isolated', async () => {
    const oldStore = createMemoryGenerativeCaptureStore('clerk:one')
    const newStore = createMemoryGenerativeCaptureStore('clerk:two')
    await oldStore.save(pendingDraft())
    let reply!: (value: unknown) => void
    api.job.mockImplementation(() => new Promise((resolve) => { reply = resolve }))
    const view = setup(oldStore)
    await waitFor(() => expect(api.job).toHaveBeenCalledTimes(1))
    view.rerender(<Generative360Page {...view.props} captureOwnerKey="clerk:two" store={newStore} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
    await act(async () => reply({ id: 'saved-job', status: 'completed', stage: 'Done' }))
    expect(screen.queryByAltText('Reference photo 1')).not.toBeInTheDocument()
    expect(api.download).not.toHaveBeenCalled()
    expect(await newStore.list()).toEqual([])
    expect((await oldStore.list())[0].photos).toHaveLength(1)
  })
  it('rejects more than four photos without changing an existing draft', async () => {
    const { store } = setup()
    await addPhoto()
    await userEvent.upload(screen.getByLabelText('Choose reference photos'), [photo, photo, photo, photo])
    await screen.findByRole('alert')
    expect((await store.list())[0].photos).toHaveLength(1)
    expect(api.start).not.toHaveBeenCalled()
  })
  it('only resends a confirmed missing request after consent, with its original job id and inputs', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    const original = pendingDraft()
    original.job!.status = 'submission-unknown'
    await store.save(original)
    api.job.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
    setup(store)
    const resend = await screen.findByRole('button', { name: 'Send saved request again' })
    expect(resend).toBeDisabled()
    expect(api.start).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox'))
    api.job.mockResolvedValue({ id: 'saved-job', status: 'running', stage: 'Imagining the room' })
    await userEvent.click(resend)
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-job', prompt: 'My room', azimuths: [0], consent: true }))
    expect((await store.list())[0].job?.id).toBe('saved-job')
  })
  it('retains the newest annotation while its delayed write overlaps Continue and Save', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    api.job.mockResolvedValue({ id: 'saved-job', status: 'completed', stage: 'Done' })
    const { onSave } = setup(store)
    await screen.findByRole('heading', { name: 'Look around your AI scene' })
    const originalSave = store.save.bind(store)
    let finishWrite!: () => void
    vi.spyOn(store, 'save').mockImplementationOnce((value) => new Promise((resolve) => {
      finishWrite = () => { void originalSave(value).then(resolve) }
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Add a point' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add a title' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save to Moments' }))
    expect(onSave).not.toHaveBeenCalled()
    await act(async () => finishWrite())
    await screen.findByRole('heading', { name: 'Saved to Moments' })
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ annotations: [expect.objectContaining({ message: 'Look here' })] }))
  })
  it('does not invoke a save callback after unmount while persistence is pending', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    api.job.mockResolvedValue({ id: 'saved-job', status: 'completed', stage: 'Done' })
    const view = setup(store)
    await screen.findByRole('heading', { name: 'Look around your AI scene' })
    await userEvent.click(screen.getByRole('button', { name: 'Add a title' }))
    let finishWrite!: () => void
    const originalSave = store.save.bind(store)
    vi.spyOn(store, 'save').mockImplementationOnce((value) => new Promise((resolve) => {
      finishWrite = () => { void originalSave(value).then(resolve) }
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Save to Moments' }))
    await waitFor(() => expect(finishWrite).toBeTypeOf('function'))
    view.unmount()
    await act(async () => finishWrite())
    expect(view.onSave).not.toHaveBeenCalled()
    expect((await store.list())[0].result).toBeDefined()
  })
  it('does not show an undurable generated preview when saving the result fails', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    const originalSave = store.save.bind(store)
    vi.spyOn(store, 'save').mockImplementation(async (value) => {
      if (value.result) throw new Error('Storage full: could not keep the result')
      await originalSave(value)
    })
    api.job.mockResolvedValue({ id: 'saved-job', status: 'completed', stage: 'Done' })
    setup(store)
    await screen.findByText(/storage full: could not keep the result/i)
    expect(screen.queryByRole('heading', { name: 'Look around your AI scene' })).not.toBeInTheDocument()
    expect((await store.list())[0].photos).toHaveLength(1)
    expect((await store.list())[0].result).toBeUndefined()
  })
  it('treats an explicit unavailable response as a failed request, allowing a consented retry', async () => {
    setup()
    await addPhoto()
    api.start.mockRejectedValue(Object.assign(new Error('The local model is still loading.'), { status: 503 }))
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await screen.findByRole('heading', { name: 'The scene could not be created' })
    expect(screen.getByRole('button', { name: 'Try a new generation' })).toBeInTheDocument()
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(api.job).not.toHaveBeenCalled()
  })
  it('refreshes model readiness without discarding photos or starting a job', async () => {
    api.health.mockResolvedValueOnce({ ready: false, provider: 'local', model: '', maxPhotos: 4, reason: 'The computer could not respond (502).' })
    const { store } = setup()
    await addPhoto()
    expect(screen.getByText(/your generation computer is not ready or connected/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    expect((await store.list())[0].photos).toHaveLength(1)
    expect(api.start).not.toHaveBeenCalled()
  })
  it('creates a separate retained photo draft for another version without automatic generation', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    await store.save(pendingDraft())
    api.job.mockResolvedValue({ id: 'saved-job', status: 'completed', stage: 'Done' })
    const { onSave } = setup(store)
    await screen.findByRole('heading', { name: 'Look around your AI scene' })
    const originalResult = (await store.list())[0].result
    await userEvent.click(screen.getByRole('button', { name: 'Try another version' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: /tell us about this place/i })).toHaveValue('My room')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Generate my 360° scene' })).toBeDisabled()
    const records = await store.list()
    expect(records).toHaveLength(2)
    const original = records.find((record) => record.id === 'saved-draft')!
    const next = records.find((record) => record.id !== 'saved-draft')!
    expect(original.result).toEqual(originalResult)
    expect(original.photos[0].original).toBe(photo)
    expect(next.photos).toEqual(original.photos)
    expect(next.job).toBeUndefined()
    expect(next.result).toBeUndefined()
    expect(next.annotations).toEqual([])
    expect(api.start).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
  it('persists portrait and landscape estimates using upright dimensions and transfers only ordered angles', async () => {
    const { props, store } = setup()
    const portrait = new File(['portrait original'], 'portrait.jpg', { type: 'image/jpeg' })
    const landscape = new File(['landscape original'], 'landscape.jpg', { type: 'image/jpeg' })
    props.preparePhoto.mockResolvedValueOnce({ ...prepared, width: 1080, height: 1920 })
      .mockResolvedValueOnce({ ...prepared, width: 1920, height: 1080 })
    api.estimateFov.mockResolvedValueOnce({ horizontalFovDegrees: 40.6, source: 'exif-35mm-equivalent', estimated: true })
      .mockResolvedValueOnce({ horizontalFovDegrees: 66.6, source: 'diagonal-fallback', estimated: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
    await userEvent.upload(screen.getByLabelText('Choose reference photos'), [portrait, landscape])
    await screen.findByAltText('Reference photo 2')
    expect(api.estimateFov).toHaveBeenNthCalledWith(1, portrait, { width: 1080, height: 1920 })
    expect(api.estimateFov).toHaveBeenNthCalledWith(2, landscape, { width: 1920, height: 1080 })
    api.start.mockImplementation(async (request) => {
      const stored = (await store.list())[0]
      expect(stored.photos.map((item) => item.fieldOfView?.horizontalFovDegrees)).toEqual([40.6, 66.6])
      expect(stored.photos.map((item) => item.original)).toEqual([portrait, landscape])
      return { id: request.id, status: 'running', stage: 'Imagining the room' }
    })
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled())
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    const request = api.start.mock.calls[0][0]
    expect(request.horizontalFovs).toEqual([40.6, 66.6])
    expect(request.azimuths).toEqual([0, 90])
    expect(Object.keys(request).sort()).toEqual(['azimuths', 'consent', 'files', 'horizontalFovs', 'id', 'prompt', 'signal'])
    expect(request.files[0]).not.toBe(portrait)
    expect(request.files[1]).not.toBe(landscape)
    expect(api.estimateFov).toHaveBeenCalledTimes(2)
  })
  it('fills only missing estimates in an older draft on explicit generation and persists them before submission', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    const old = pendingDraft()
    delete old.job
    old.photos.push({ ...old.photos[0], id: 'known-photo', azimuth: 90,
      fieldOfView: { horizontalFovDegrees: 43.2, source: 'exif-35mm-equivalent', estimated: true } })
    await store.save(old)
    setup(store)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
    expect(api.estimateFov).not.toHaveBeenCalled()
    expect((await store.list())[0].photos[0].fieldOfView).toBeUndefined()
    api.start.mockImplementation(async (request) => {
      expect((await store.list())[0].photos.map((item) => item.fieldOfView?.horizontalFovDegrees)).toEqual([72, 43.2])
      return { id: request.id, status: 'running', stage: 'Imagining the room' }
    })
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1))
    expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ horizontalFovs: [72, 43.2] }))
    expect(api.estimateFov).toHaveBeenCalledOnce()
    expect(api.estimateFov).toHaveBeenCalledWith(photo, { width: 1600, height: 1200 })
    expect((await store.list())[0].photos[0].original).toBe(photo)
  })
  it('does not submit or change an old draft after leaving during a local estimate', async () => {
    const store = createMemoryGenerativeCaptureStore('clerk:one')
    const old = pendingDraft()
    delete old.job
    await store.save(old)
    let finishEstimate!: (value: unknown) => void
    api.estimateFov.mockImplementationOnce(() => new Promise((resolve) => { finishEstimate = resolve }))
    const view = setup(store)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled())
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await waitFor(() => expect(api.estimateFov).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => finishEstimate({ horizontalFovDegrees: 40.6, source: 'diagonal-fallback', estimated: true }))
    expect(api.start).not.toHaveBeenCalled()
    const retained = (await store.list())[0]
    expect(retained.photos[0].original).toBe(photo)
    expect(retained.photos[0].fieldOfView).toBeUndefined()
    expect(retained.job).toBeUndefined()
  })
  it('keeps a failed photo-add visible so a later consented request cannot include hidden photos', async () => {
    const { store } = setup()
    await addPhoto()
    const another = new File(['another original'], 'another.jpg', { type: 'image/jpeg' })
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Storage is full'))
    await userEvent.upload(screen.getByLabelText('Choose reference photos'), another)
    await screen.findByText(/latest photo changes are shown but are not saved yet/i)
    expect(screen.getByAltText('Reference photo 2')).toBeInTheDocument()
    expect((await store.list())[0].photos).toHaveLength(1)
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Generate my 360° scene' }))
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce())
    expect(api.start.mock.calls[0][0].files).toHaveLength(2)
    expect((await store.list())[0].photos[1].original).toBe(another)
  })
  it('keeps Close disabled until an incoming camera photo is prepared and saved', async () => {
    const view = setup()
    let finishPreparing!: () => void
    view.props.preparePhoto.mockImplementationOnce(() => new Promise((resolve) => { finishPreparing = () => resolve(prepared) }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take a photo' })).toBeEnabled())
    await userEvent.upload(screen.getByLabelText('Take a reference photo'), photo)
    expect(screen.getByRole('button', { name: 'Close scene creator' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Close scene creator' }))
    expect(view.props.onClose).not.toHaveBeenCalled()
    await act(async () => finishPreparing())
    await screen.findByAltText('Reference photo 1')
    expect(screen.getByRole('button', { name: 'Close scene creator' })).toBeEnabled()
    expect((await view.store.list())[0].photos[0].original).toBe(photo)
  })
})
