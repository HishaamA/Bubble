import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryJournalPhotoStore } from './journalPhotoStore'
import type {
  JournalPhoto,
  JournalPhotoImportResult,
  JournalPhotoStore,
} from './journalPhotoTypes'

const mocks = vi.hoisted(() => ({
  capturedAt: vi.fn(),
  process: vi.fn(),
  fetch: vi.fn(),
  upload: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
}))

vi.mock('../capsules/capsulePhotoDate', () => ({
  getCapsulePhotoCapturedAt: mocks.capturedAt,
}))

vi.mock('../capsules/processCapsuleImage', () => ({
  processCapsuleImage: mocks.process,
}))

vi.mock('./journalPhotoService', () => ({
  fetchFamilyJournalPhotos: mocks.fetch,
  uploadFamilyJournalPhoto: mocks.upload,
  subscribeToFamilyJournalPhotos: mocks.subscribe,
}))

import { useJournalPhotoLibrary } from './journalPhotoLibrary'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function Harness({ store }: { store: JournalPhotoStore }) {
  const library = useJournalPhotoLibrary({
    cacheNamespace: 'user:family',
    contributorName: 'Maya Ahmed',
    store,
  })
  const [result, setResult] = useState<JournalPhotoImportResult | null>(null)
  return (
    <>
      <input
        type="file"
        multiple
        aria-label="Import family photos"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          void library.importPhotos(files).then(setResult)
        }}
      />
      <output aria-label="Library state">
        {library.loading ? 'loading' : 'ready'}|{library.photos.length}|
        {library.importProgress.importing ? 'importing' : 'idle'}|
        {library.importProgress.completed}/{library.importProgress.total}|
        {result ? `${result.added}/${result.failed}` : 'none'}|
        pending:{library.photos.filter(({ syncStatus }) => syncStatus === 'pending').length}
      </output>
    </>
  )
}

describe('useJournalPhotoLibrary', () => {
  beforeEach(() => {
    mocks.capturedAt.mockReset()
    mocks.capturedAt.mockImplementation(async (file: File) =>
      file.name.startsWith('old')
        ? '2010-01-01T12:00:00.000Z'
        : '2020-01-01T12:00:00.000Z',
    )
    mocks.process.mockReset()
    mocks.process.mockImplementation(async (file: File) => {
      if (file.name.startsWith('broken')) throw new Error('Unsupported')
      return {
        image: new Blob([`full-${file.name}`], { type: 'image/jpeg' }),
        thumbnail: new Blob([`thumb-${file.name}`], { type: 'image/jpeg' }),
        width: 1200,
        height: 900,
        thumbnailWidth: 400,
        thumbnailHeight: 300,
      }
    })
    mocks.fetch.mockReset()
    mocks.fetch.mockResolvedValue([])
    mocks.upload.mockReset()
    mocks.upload.mockResolvedValue(null)
    mocks.subscribe.mockReset()
    mocks.subscribe.mockResolvedValue(() => undefined)
  })

  it('persists a batch sequentially and keeps successful files after a partial failure', async () => {
    const user = userEvent.setup()
    const store = createMemoryJournalPhotoStore()
    render(<Harness store={store} />)
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent('ready'))

    const oldPhoto = new File(['old'], 'old-photo.jpg', { type: 'image/jpeg' })
    const brokenPhoto = new File(['broken'], 'broken-photo.heic', { type: 'image/heic' })
    const newPhoto = new File(['new'], 'new_photo.png', { type: 'image/png' })
    await user.upload(
      screen.getByLabelText('Import family photos'),
      [oldPhoto, brokenPhoto, newPhoto],
    )

    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent(
      'ready|2|idle|3/3|2/1',
    ))
    expect(mocks.process.mock.calls.map(([file]) => file.name)).toEqual([
      'old-photo.jpg',
      'broken-photo.heic',
      'new_photo.png',
    ])
    const saved = await store.list()
    expect(saved).toHaveLength(2)
    expect(saved.map(({ caption }) => caption).sort()).toEqual([
      'new photo',
      'old photo',
    ])
    expect(saved.map(({ capturedAt }) => capturedAt).sort()).toEqual([
      '2010-01-01T12:00:00.000Z',
      '2020-01-01T12:00:00.000Z',
    ])
    expect(saved.every(({ image, thumbnail }) =>
      image instanceof Blob && thumbnail instanceof Blob,
    )).toBe(true)
  })

  it('rebases a delayed refresh over a photo imported while storage was loading', async () => {
    const user = userEvent.setup()
    const delayedList = deferred<JournalPhoto[]>()
    const saved = new Map<string, JournalPhoto>()
    const store: JournalPhotoStore = {
      list: vi.fn(() => delayedList.promise),
      save: vi.fn(async (photo) => {
        saved.set(photo.id, photo)
      }),
      remove: vi.fn(async (id) => {
        saved.delete(id)
      }),
    }
    render(<Harness store={store} />)

    await user.upload(
      screen.getByLabelText('Import family photos'),
      new File(['new'], 'new.jpg', { type: 'image/jpeg' }),
    )
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent(
      'loading|1|idle|1/1|1/0',
    ))

    delayedList.resolve([])
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent(
      'ready|1|idle|1/1|1/0',
    ))
    expect(saved.size).toBe(1)
  })

  it('drains a second batch added while the first family sync is in flight', async () => {
    const user = userEvent.setup()
    const firstUpload = deferred<string | null>()
    let firstPhotoId = ''
    mocks.upload.mockImplementationOnce(async (input: { photoId: string }) => {
      firstPhotoId = input.photoId
      return firstUpload.promise
    })
    mocks.upload.mockImplementation(async (input: { photoId: string }) => input.photoId)
    const store = createMemoryJournalPhotoStore()
    render(<Harness store={store} />)
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent('ready'))

    await user.upload(
      screen.getByLabelText('Import family photos'),
      new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
    )
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1))
    await user.upload(
      screen.getByLabelText('Import family photos'),
      new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
    )
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent(
      /ready\|2\|idle\|1\/1\|1\/0\|\s*pending:2/,
    ))

    firstUpload.resolve(firstPhotoId)
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent(
      'pending:0',
    ))
  })

  it('cancels the remaining batch before persistence or sync after unmount', async () => {
    const user = userEvent.setup()
    const delayedProcess = deferred<{
      image: Blob
      thumbnail: Blob
      width: number
      height: number
      thumbnailWidth: number
      thumbnailHeight: number
    }>()
    mocks.process.mockReturnValueOnce(delayedProcess.promise)
    const store = createMemoryJournalPhotoStore()
    const save = vi.spyOn(store, 'save')
    const view = render(<Harness store={store} />)
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent('ready'))

    await user.upload(
      screen.getByLabelText('Import family photos'),
      new File(['slow'], 'slow.jpg', { type: 'image/jpeg' }),
    )
    await waitFor(() => expect(mocks.process).toHaveBeenCalledTimes(1))
    view.unmount()
    delayedProcess.resolve({
      image: new Blob(['full']),
      thumbnail: new Blob(['thumb']),
      width: 1200,
      height: 900,
      thumbnailWidth: 400,
      thumbnailHeight: 300,
    })

    await delayedProcess.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(save).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('does not restart a pending sync after a delayed refresh resolves post-unmount', async () => {
    const delayedFetch = deferred<JournalPhoto[]>()
    mocks.fetch.mockReturnValueOnce(delayedFetch.promise)
    const pending: JournalPhoto = {
      id: '33333333-3333-4333-8333-333333333333',
      image: new Blob(['full'], { type: 'image/jpeg' }),
      thumbnail: new Blob(['thumb'], { type: 'image/jpeg' }),
      width: 1200,
      height: 900,
      thumbnailWidth: 400,
      thumbnailHeight: 300,
      caption: 'Pending',
      capturedAt: '2020-01-01T12:00:00.000Z',
      contributorName: 'Maya Ahmed',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }
    const view = render(
      <Harness store={createMemoryJournalPhotoStore([pending])} />,
    )
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce())

    view.unmount()
    delayedFetch.resolve([])
    await delayedFetch.promise
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('lets later pending photos sync after three earlier records fail', async () => {
    const pendingPhotos = ['a', 'b', 'c', 'd'].map((id): JournalPhoto => ({
      id,
      image: new Blob([`full-${id}`], { type: 'image/jpeg' }),
      thumbnail: new Blob([`thumb-${id}`], { type: 'image/jpeg' }),
      width: 1200,
      height: 900,
      thumbnailWidth: 400,
      thumbnailHeight: 300,
      caption: id,
      capturedAt: '2020-01-01T12:00:00.000Z',
      contributorName: 'Maya Ahmed',
      ownedByCurrentUser: true,
      syncStatus: 'pending',
    }))
    mocks.upload.mockImplementation(async (input: { photoId: string }) => {
      if (input.photoId === 'a') return input.photoId
      throw new Error('Rejected photo')
    })
    render(
      <Harness store={createMemoryJournalPhotoStore(pendingPhotos)} />,
    )
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(3))

    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ photoId: 'a' }),
    ))
    await waitFor(() => expect(screen.getByLabelText('Library state')).toHaveTextContent(
      'pending:3',
    ))
  })
})
