import { App as CapacitorApp } from '@capacitor/app'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth'
import '../FeaturePages.css'
import './CapsulesPage.css'
import {
  addLocalDays,
  formatCapsuleCountdown,
  getWeeklyCapsuleWindow,
  isCapsuleUnlocked,
  startOfCapsuleWeek,
  toLocalDateInput,
} from './capsuleDates'
import {
  capsuleRecapFileExtension,
  renderBrowserCapsuleRecap,
} from './recap/browserCapsuleRecap'
import {
  discardNativeCapsuleRecapArtifacts,
  isNativeCapsuleRecapAvailable,
  renderNativeCapsuleRecap,
  shareNativeCapsuleRecap,
  stageNativeCapsuleRecapImage,
} from './recap/nativeCapsuleRecap'
import { CAPSULE_RECAP_PHOTO_DURATION_MS } from './recap/recapPlan'
import {
  createDefaultCapsuleStore,
  createMemoryCapsuleStore,
} from './capsuleStore'
import {
  createFamilySpecialCapsule,
  ensureFamilyWeeklyCapsule,
  fetchFamilyCapsules,
  subscribeToFamilyCapsules,
  uploadFamilyCapsulePhoto,
} from './capsuleService'
import { getCapsulePhotoCapturedAt } from './capsulePhotoDate'
import { processCapsuleImage } from './processCapsuleImage'
import type {
  CapsuleImageSource,
  CapsulePhoto,
  CapsuleStore,
  FamilyCapsule,
} from './types'

type CapsulesPageProps = {
  now?: Date
  store?: CapsuleStore
  cacheNamespace?: string
}

function createId(_prefix: string) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function weeklyCapsuleId(weekStart: Date) {
  return `weekly-${toLocalDateInput(weekStart)}`
}

function createCurrentWeeklyCapsule(
  now: Date,
  createdByName = 'You',
): FamilyCapsule {
  const window = getWeeklyCapsuleWindow(now)
  return {
    id: weeklyCapsuleId(window.weekStart),
    kind: 'weekly',
    title: 'This week',
    weekStart: toLocalDateInput(window.weekStart),
    createdAt: window.weekStart.toISOString(),
    closesAt: window.closesAt.toISOString(),
    opensAt: window.opensAt.toISOString(),
    createdByName,
    photos: [],
    totalPhotoCount: 0,
    familySynced: false,
  }
}

function orderCapsules(capsules: FamilyCapsule[]) {
  return [...capsules].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'weekly' ? -1 : 1
    return right.createdAt.localeCompare(left.createdAt)
  })
}

function mergeCapsules(
  localCapsules: FamilyCapsule[],
  familyCapsules: FamilyCapsule[],
) {
  const consumedLocalIds = new Set<string>()
  const mergedFamily = familyCapsules.map((familyCapsule) => {
    const localCapsule = localCapsules.find((candidate) => (
      candidate.id === familyCapsule.id || (
        candidate.kind === 'weekly' &&
        familyCapsule.kind === 'weekly' &&
        candidate.weekStart === familyCapsule.weekStart
      )
    ))
    if (!localCapsule) return familyCapsule
    consumedLocalIds.add(localCapsule.id)
    const localPhotosById = new Map(
      localCapsule.photos.map((photo) => [photo.id, photo]),
    )
    const durableFamilyPhotos = familyCapsule.photos.map((familyPhoto) => {
      const localPhoto = localPhotosById.get(familyPhoto.id)
      if (!localPhoto) return familyPhoto
      return {
        ...familyPhoto,
        image: typeof localPhoto.image === 'string'
          ? familyPhoto.image
          : localPhoto.image,
        thumbnail: typeof localPhoto.thumbnail === 'string'
          ? familyPhoto.thumbnail
          : localPhoto.thumbnail,
      }
    })
    const familyPhotoIds = new Set(durableFamilyPhotos.map(({ id }) => id))
    const localOnlyPhotos = localCapsule.photos
      .filter((photo) => (
        !familyPhotoIds.has(photo.id) && (
          photo.syncStatus === 'pending' ||
          typeof photo.image !== 'string' ||
          typeof photo.thumbnail !== 'string'
        )
      ))
      .map((photo) => ({ ...photo, capsuleId: familyCapsule.id }))
    const pendingPhotoCount = localOnlyPhotos.filter(
      ({ syncStatus }) => syncStatus === 'pending',
    ).length
    const syncedVisiblePhotoCount = durableFamilyPhotos.length +
      localOnlyPhotos.length - pendingPhotoCount
    return {
      ...familyCapsule,
      photos: [...durableFamilyPhotos, ...localOnlyPhotos]
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
      totalPhotoCount: Math.max(
        familyCapsule.totalPhotoCount ?? familyCapsule.photos.length,
        syncedVisiblePhotoCount,
      ) + pendingPhotoCount,
    }
  })

  return orderCapsules([
    ...mergedFamily,
    ...localCapsules.filter(({ id }) => !consumedLocalIds.has(id) && !familyCapsules.some(({ id: familyId }) => familyId === id)),
  ])
}

type CapsuleSyncResult = {
  capsules: FamilyCapsule[]
  authoritativeWeeklyId: string
  familyAvailable: boolean
}

async function persistCapsuleSnapshot(
  store: CapsuleStore,
  previous: FamilyCapsule[],
  next: FamilyCapsule[],
) {
  const nextIds = new Set(next.map(({ id }) => id))
  await Promise.all([
    ...previous
      .filter(({ id }) => !nextIds.has(id))
      .map(({ id }) => store.remove(id)),
    ...next.map((capsule) => store.save(capsule)),
  ])
}

async function synchronizeCapsuleSnapshot(input: {
  store: CapsuleStore
  displayName: string
  now: Date
  localWeekKey: string
}): Promise<CapsuleSyncResult> {
  const saved = await input.store.list()
  let next = saved
  let authoritativeWeeklyId = ''
  let familyAvailable = false

  try {
    const authoritativeWeekly = await ensureFamilyWeeklyCapsule()
    if (authoritativeWeekly) {
      familyAvailable = true
      authoritativeWeeklyId = authoritativeWeekly.id
      next = mergeCapsules(saved, await fetchFamilyCapsules())

      for (let index = 0; index < next.length; index += 1) {
        const capsule = next[index]
        if (capsule.kind !== 'special' || capsule.familySynced !== false) continue
        try {
          const familyId = await createFamilySpecialCapsule(
            capsule.title,
            capsule.opensAt,
            capsule.id,
          )
          if (familyId) {
            next[index] = {
              ...capsule,
              id: familyId,
              familySynced: true,
              photos: capsule.photos.map((photo) => ({
                ...photo,
                capsuleId: familyId,
              })),
            }
          }
        } catch {
          // The durable local draft remains pending for the next refresh/resume.
        }
      }

      for (let capsuleIndex = 0; capsuleIndex < next.length; capsuleIndex += 1) {
        const capsule = next[capsuleIndex]
        if (capsule.familySynced !== true || isCapsuleUnlocked(capsule.opensAt, input.now)) continue
        const photos = [...capsule.photos]
        for (let photoIndex = 0; photoIndex < photos.length; photoIndex += 1) {
          const photo = photos[photoIndex]
          if (
            photo.syncStatus !== 'pending' ||
            typeof photo.image === 'string' ||
            typeof photo.thumbnail === 'string' ||
            !photo.thumbnailWidth ||
            !photo.thumbnailHeight
          ) continue
          try {
            const familyPhotoId = await uploadFamilyCapsulePhoto({
              capsuleId: capsule.id,
              itemId: photo.id,
              photo: {
                image: photo.image,
                thumbnail: photo.thumbnail,
                width: photo.width,
                height: photo.height,
                thumbnailWidth: photo.thumbnailWidth,
                thumbnailHeight: photo.thumbnailHeight,
              },
              caption: photo.caption,
              capturedAt: photo.capturedAt,
            })
            if (familyPhotoId) {
              photos[photoIndex] = {
                ...photo,
                id: familyPhotoId,
                capsuleId: capsule.id,
                syncStatus: 'synced',
              }
            }
          } catch {
            // Keep the re-encoded Blobs in IndexedDB and retry on refresh/resume.
          }
        }
        next[capsuleIndex] = { ...capsule, photos }
      }

      try {
        next = mergeCapsules(next, await fetchFamilyCapsules())
      } catch {
        // Successful writes remain in the local snapshot until URLs can refresh.
      }
    }
  } catch {
    // No remote family context: keep the account-and-family-scoped local queue.
  }

  if (!authoritativeWeeklyId) {
    const localWeekly = next.find(
      (capsule) => capsule.kind === 'weekly' && capsule.weekStart === input.localWeekKey,
    )
    if (localWeekly) {
      authoritativeWeeklyId = localWeekly.id
    } else {
      const weekly = createCurrentWeeklyCapsule(
        new Date(`${input.localWeekKey}T12:00:00`),
        input.displayName,
      )
      next = [weekly, ...next]
      authoritativeWeeklyId = weekly.id
    }
  }

  next = orderCapsules(next)
  await persistCapsuleSnapshot(input.store, saved, next)
  return { capsules: next, authoritativeWeeklyId, familyAvailable }
}

function formatWeekRange(capsule: FamilyCapsule) {
  const start = capsule.weekStart
    ? new Date(`${capsule.weekStart}T12:00:00`)
    : new Date(capsule.createdAt)
  const end = addLocalDays(start, 6)
  const startLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(start)
  const endLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(end)
  return `${startLabel}–${endLabel}`
}

function capsuleDisplayTitle(capsule: FamilyCapsule) {
  return capsule.kind === 'weekly' ? formatWeekRange(capsule) : capsule.title
}

function formatOpenDate(capsule: FamilyCapsule) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(capsule.opensAt))
}

function formatExactOpenDate(opensAt: string) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(opensAt))
}

function photoCountLabel(count: number) {
  return `${count} ${count === 1 ? 'photo' : 'photos'}`
}

function capsuleHasPhotos(capsule: FamilyCapsule) {
  return Math.max(capsule.totalPhotoCount ?? 0, capsule.photos.length) > 0
}

function capsuleRecapPhotos(photos: CapsulePhoto[]) {
  return photos.filter(({ image }) => {
    if (typeof image !== 'string') return image.size > 0

    const source = image.trim()
    // Object URLs belong to one WebView session. An older URL can still be in
    // the Capsule metadata after a legacy app restart, but it cannot be opened
    // or rendered into a recap. Pending IndexedDB Blobs, on the other hand,
    // are fully usable on this phone even before family sync succeeds.
    return source.length > 0 && !source.startsWith('blob:')
  })
}

async function imageSourceToBlob(source: CapsuleImageSource) {
  if (typeof source !== 'string') return source
  const response = await fetch(source)
  if (!response.ok) throw new Error('One of the Capsule photos could not be opened.')
  return response.blob()
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('One of the Capsule photos could not be prepared.'))
    reader.onerror = () => reject(reader.error ?? new Error('One of the Capsule photos could not be prepared.'))
    reader.readAsDataURL(blob)
  })
}

function CapsulePhotoImage({
  source,
  alt,
}: {
  source: CapsuleImageSource
  alt: string
}) {
  const [blobPreview, setBlobPreview] = useState<{
    source: Blob
    url: string
  } | null>(null)
  const [loadedSource, setLoadedSource] = useState<CapsuleImageSource | null>(null)
  const [failedSource, setFailedSource] = useState<CapsuleImageSource | null>(null)

  useEffect(() => {
    if (typeof source === 'string' || typeof URL.createObjectURL !== 'function') return

    const objectUrl = URL.createObjectURL(source)
    // oxlint-disable-next-line react/set-state-in-effect -- Blob URLs are external browser resources created and released with this effect.
    setBlobPreview({ source, url: objectUrl })
    return () => URL.revokeObjectURL?.(objectUrl)
  }, [source])

  const legacyObjectUrl = typeof source === 'string' && source.startsWith('blob:')
  const src = typeof source === 'string'
    ? legacyObjectUrl ? '' : source
    : blobPreview?.source === source ? blobPreview.url : ''
  const failed = legacyObjectUrl || failedSource === source
  const loaded = loadedSource === source

  if (!src || failed) {
    return (
      <span
        className="capsule-photo-placeholder"
        role="img"
        aria-label={`${alt}. Preview unavailable until KinSphere reconnects.`}
      >
        <span aria-hidden="true">✦</span>
      </span>
    )
  }

  return (
    <span className="capsule-photo-media" data-ready={loaded ? 'true' : 'false'}>
      <img
        src={src}
        alt={alt}
        aria-hidden={loaded ? undefined : 'true'}
        draggable="false"
        onLoad={() => setLoadedSource(source)}
        onError={() => setFailedSource(source)}
      />
      {!loaded ? (
        <span
          className="capsule-photo-placeholder"
          role="img"
          aria-label={`${alt}. Loading preview.`}
        >
          <span aria-hidden="true">✦</span>
        </span>
      ) : null}
    </span>
  )
}

function CapsuleLockIcon() {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path d="M8.25 12.25V9.7a5.75 5.75 0 0 1 11.5 0v2.55" />
      <rect x="5.75" y="12.25" width="16.5" height="12" rx="5" />
      <path d="M14 17.1v3.1" />
    </svg>
  )
}

function PhotoStrip({
  photos,
  totalPhotoCount,
  locked,
  opensAt,
}: {
  photos: CapsulePhoto[]
  totalPhotoCount: number
  locked: boolean
  opensAt: string
}) {
  const representedPhotoCount = Math.max(photos.length, totalPhotoCount)
  if (representedPhotoCount === 0) {
    return (
      <div className="capsule-photo-strip capsule-photo-strip--empty">
        <span aria-hidden="true">＋</span>
        <p>The first little moment can be yours.</p>
      </div>
    )
  }

  const visiblePhotos = photos.slice(0, 6)
  const concealedSlotCount = Math.max(
    0,
    Math.min(6, representedPhotoCount) - visiblePhotos.length,
  )

  return (
    <div className="capsule-collection__photos" data-locked={locked ? 'true' : 'false'}>
      <ul
        className="capsule-photo-strip"
        aria-hidden={locked ? 'true' : undefined}
        aria-label={locked ? undefined : `${photoCountLabel(representedPhotoCount)} in this Capsule`}
      >
        {visiblePhotos.map((photo) => (
          <li key={photo.id}>
            <CapsulePhotoImage
              source={photo.thumbnail}
              alt={`${photo.caption || 'Capsule photo'} from ${photo.contributorName}`}
            />
          </li>
        ))}
        {Array.from({ length: concealedSlotCount }, (_, index) => (
          <li
            className="capsule-photo-strip__concealed"
            key={`concealed-${index}`}
            aria-hidden="true"
          />
        ))}
        {representedPhotoCount > 6 ? (
          <li className="capsule-photo-strip__more">+{representedPhotoCount - 6}</li>
        ) : null}
      </ul>
      {locked ? (
        <div
          className="capsule-locked-cover"
          role="img"
          aria-label={`Locked until ${formatExactOpenDate(opensAt)}`}
        >
          <span className="capsule-locked-cover__icon"><CapsuleLockIcon /></span>
          <span>This Capsule unlocks</span>
          <time dateTime={opensAt}>{formatExactOpenDate(opensAt)}</time>
        </div>
      ) : null}
    </div>
  )
}

function CapsuleCard({
  capsule,
  now,
  uploading,
  demoUnlocked,
  onChoosePhoto,
  onOpenRecap,
  onDemoUnlock,
}: {
  capsule: FamilyCapsule
  now: Date
  uploading: boolean
  demoUnlocked: boolean
  onChoosePhoto: (event: ChangeEvent<HTMLInputElement>, capsule: FamilyCapsule) => void
  onOpenRecap: (capsule: FamilyCapsule) => void
  onDemoUnlock: (capsule: FamilyCapsule) => void
}) {
  const unlocked = isCapsuleUnlocked(capsule.opensAt, now)
  const canContribute = !unlocked
  const totalPhotoCount = capsule.totalPhotoCount ?? capsule.photos.length
  const pendingPhotoCount = capsule.photos.filter(({ syncStatus }) => syncStatus === 'pending').length
  const recapPhotoCount = capsuleRecapPhotos(capsule.photos).length
  const displayTitle = capsuleDisplayTitle(capsule)

  return (
    <article
      className="capsule-collection"
      data-kind={capsule.kind}
      data-demo-unlocked={demoUnlocked ? 'true' : 'false'}
    >
      <header className="capsule-collection__header">
        <div>
          {capsule.kind === 'special' ? <p>Special Capsule</p> : null}
          <h2>{displayTitle}</h2>
        </div>
        <span className="capsule-collection__state" data-unlocked={unlocked ? 'true' : 'false'}>
          {unlocked ? 'Open' : formatCapsuleCountdown(capsule.opensAt, now)}
        </span>
      </header>

      <PhotoStrip
        photos={capsule.photos}
        totalPhotoCount={totalPhotoCount}
        locked={!unlocked && !demoUnlocked}
        opensAt={capsule.opensAt}
      />

      <div className="capsule-collection__details">
        <p>
          <strong>{photoCountLabel(totalPhotoCount)}</strong>
          <span>
            {pendingPhotoCount > 0
              ? unlocked
                ? `${photoCountLabel(pendingPhotoCount)} saved on this phone`
                : `${photoCountLabel(pendingPhotoCount)} waiting to share`
              : unlocked
                ? 'ready for your family recap'
                : `opens ${formatOpenDate(capsule)}`}
          </span>
        </p>
        {canContribute ? (
          <label className="capsule-add-photo">
            <input
              type="file"
              accept="image/*"
              disabled={uploading}
              onChange={(event) => onChoosePhoto(event, capsule)}
            />
            <span aria-hidden="true">+</span>
            {uploading ? 'Adding…' : 'Add photo'}
          </label>
        ) : (
          <button
            className="capsule-open-recap"
            type="button"
            disabled={recapPhotoCount === 0}
            onClick={() => onOpenRecap(capsule)}
          >
            {recapPhotoCount > 0 ? 'Play recap' : 'Photos unavailable on this phone'}
          </button>
        )}
      </div>
      {!unlocked && capsule.photos.length > 0 ? (
        <button
          className="capsule-demo-unlock"
          type="button"
          aria-label={`Demo only: Preview ${displayTitle} recap`}
          onClick={() => onDemoUnlock(capsule)}
        >
          <span>Demo only</span>
          Preview this Capsule recap
        </button>
      ) : null}
    </article>
  )
}

function RecapSheet({
  capsule,
  demoMode,
  onClose,
  onPreparePhotos,
}: {
  capsule: FamilyCapsule
  demoMode: boolean
  onClose: () => void
  onPreparePhotos: () => Promise<CapsulePhoto[]>
}) {
  const orderedPhotos = useMemo(
    () => capsuleRecapPhotos(capsule.photos)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    [capsule.photos],
  )
  const displayTitle = capsuleDisplayTitle(capsule)
  const [index, setIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (orderedPhotos.length < 2) return
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % orderedPhotos.length),
      CAPSULE_RECAP_PHOTO_DURATION_MS,
    )
    return () => window.clearInterval(timer)
  }, [orderedPhotos.length])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  async function saveRecap() {
    setSaving(true)
    setStatus('Making your video…')
    const nativeArtifacts: string[] = []
    let nativeFailure: unknown
    try {
      const preparedPhotos = capsuleRecapPhotos(await onPreparePhotos())
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      if (preparedPhotos.length === 0) {
        throw new Error('These Capsule photos are not available on this phone yet.')
      }
      if (isNativeCapsuleRecapAvailable()) {
        try {
          const imagePaths: string[] = []
          for (const photo of preparedPhotos) {
            const blob = await imageSourceToBlob(photo.image)
            const dataUrl = await blobToDataUrl(blob)
            const staged = await stageNativeCapsuleRecapImage({ dataUrl })
            imagePaths.push(staged.path)
            nativeArtifacts.push(staged.path)
          }
          const video = await renderNativeCapsuleRecap({ imagePaths })
          nativeArtifacts.push(video.fileUri)
          const share = await shareNativeCapsuleRecap(video.fileUri)
          setStatus(share.completed ? 'Your recap is ready to save or share.' : 'Your recap is ready whenever you are.')
          return
        } catch (reason) {
          nativeFailure = reason
          // A device codec or share service can occasionally be unavailable.
          // Release private native artifacts before attempting the existing
          // browser renderer rather than leaving the feature at a dead end.
          await discardNativeCapsuleRecapArtifacts(nativeArtifacts).catch(() => undefined)
          nativeArtifacts.length = 0
          setStatus('Native video export was unavailable. Trying the compatible fallback…')
        }
      }

      let video: Blob
      try {
        video = await renderBrowserCapsuleRecap(preparedPhotos)
      } catch (fallbackFailure) {
        if (!nativeFailure) throw fallbackFailure
        const nativeMessage = nativeFailure instanceof Error
          ? nativeFailure.message
          : 'Native video export failed.'
        const fallbackMessage = fallbackFailure instanceof Error
          ? fallbackFailure.message
          : 'The compatible video fallback failed.'
        throw new Error(`${nativeMessage} ${fallbackMessage}`)
      }
      const objectUrl = URL.createObjectURL(video)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = `${displayTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'family-capsule'}.${capsuleRecapFileExtension(video)}`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
      setStatus('Your recap is ready in Downloads.')
    } catch (reason) {
      setStatus(reason instanceof Error ? reason.message : 'The recap could not be saved.')
    } finally {
      await discardNativeCapsuleRecapArtifacts(nativeArtifacts).catch(() => undefined)
      setSaving(false)
    }
  }

  const activePhoto = orderedPhotos[index]
  return createPortal(
    <div className="capsule-recap-sheet" role="dialog" aria-modal="true" aria-labelledby="capsule-recap-title">
      <section className="capsule-recap-sheet__panel">
        <header>
          <div>
            <p>{demoMode ? 'Demo preview' : 'Family recap'}</p>
            <h2 id="capsule-recap-title">{displayTitle}</h2>
          </div>
          <button type="button" aria-label="Close recap" onClick={onClose}>×</button>
        </header>

        <div className="capsule-recap-player" aria-live="off">
          {activePhoto ? (
            <CapsulePhotoImage source={activePhoto.image} alt={activePhoto.caption || `Photo from ${activePhoto.contributorName}`} />
          ) : null}
          <span className="capsule-recap-player__credit">{activePhoto?.contributorName}</span>
        </div>

        <div className="capsule-recap-progress" aria-hidden="true">
          {orderedPhotos.map((photo, photoIndex) => (
            <span key={photo.id} data-active={photoIndex === index ? 'true' : 'false'} />
          ))}
        </div>

        <button className="ks-primary-button capsule-recap-save" type="button" disabled={saving} onClick={() => void saveRecap()}>
          {saving ? 'Making video…' : 'Save video'}
        </button>
        <p className="capsule-recap-sheet__status" role="status" aria-live="polite">{status}</p>
      </section>
    </div>,
    document.body,
  )
}

export function CapsulesPage({
  now,
  store: suppliedStore,
  cacheNamespace,
}: CapsulesPageProps = {}) {
  const { user } = useAuth()
  const subject = user?.id ?? 'signed-out'
  const storeSubject = cacheNamespace ?? subject
  const displayName = user?.displayName?.trim() || 'You'
  const store = useMemo(
    () => suppliedStore ?? (
      typeof window === 'undefined'
        ? createMemoryCapsuleStore()
        : createDefaultCapsuleStore(storeSubject)
    ),
    [storeSubject, suppliedStore],
  )
  const [clock, setClock] = useState(() => new Date(now ?? Date.now()))
  const [capsules, setCapsules] = useState<FamilyCapsule[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [uploadingCapsuleId, setUploadingCapsuleId] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [activeRecapId, setActiveRecapId] = useState('')
  const [demoRecapId, setDemoRecapId] = useState('')
  const [authoritativeWeeklyId, setAuthoritativeWeeklyId] = useState('')
  const weekKey = toLocalDateInput(startOfCapsuleWeek(clock))
  const clockRef = useRef(clock)
  const syncPromiseRef = useRef<Promise<CapsuleSyncResult> | null>(null)
  const refreshedUnlocksRef = useRef(new Set<string>())

  useEffect(() => {
    clockRef.current = clock
  }, [clock])

  const refreshCapsules = useCallback(async () => {
    if (syncPromiseRef.current) return syncPromiseRef.current
    const request = synchronizeCapsuleSnapshot({
      store,
      displayName,
      now: clockRef.current,
      localWeekKey: weekKey,
    }).then((result) => {
      setCapsules(result.capsules)
      setAuthoritativeWeeklyId(result.authoritativeWeeklyId)
      return result
    })
    syncPromiseRef.current = request
    try {
      return await request
    } finally {
      if (syncPromiseRef.current === request) syncPromiseRef.current = null
    }
  }, [displayName, store, weekKey])

  useEffect(() => {
    if (now) return
    const timer = window.setInterval(() => setClock(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [now])

  useEffect(() => {
    let active = true
    void refreshCapsules()
      .then(() => {
        if (active) setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setAnnouncement('Capsules could not be opened on this device.')
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [refreshCapsules])

  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined
    void subscribeToFamilyCapsules(() => {
      if (active) void refreshCapsules()
    })
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unsubscribe()
    }
  }, [refreshCapsules, storeSubject])

  useEffect(() => {
    const newlyUnlocked = capsules.filter((capsule) => (
      capsule.familySynced === true &&
      isCapsuleUnlocked(capsule.opensAt, clock) &&
      !refreshedUnlocksRef.current.has(`${capsule.id}:${capsule.opensAt}`)
    ))
    if (newlyUnlocked.length === 0) return
    newlyUnlocked.forEach((capsule) => {
      refreshedUnlocksRef.current.add(`${capsule.id}:${capsule.opensAt}`)
    })
    void refreshCapsules()
  }, [capsules, clock, refreshCapsules])

  useEffect(() => {
    let active = true
    let removeNativeListener: (() => Promise<void>) | undefined
    const refreshOnResume = () => {
      setClock(new Date(now ?? Date.now()))
      void refreshCapsules()
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshOnResume()
    }
    window.addEventListener('online', refreshOnResume)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (active && isActive) refreshOnResume()
    })
      .then((handle) => {
        if (active) removeNativeListener = () => handle.remove()
        else void handle.remove()
      })
      .catch(() => undefined)
    return () => {
      active = false
      window.removeEventListener('online', refreshOnResume)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      void removeNativeListener?.()
    }
  }, [now, refreshCapsules])

  async function saveCapsule(next: FamilyCapsule) {
    setCapsules((current) => orderCapsules(current.map((capsule) => capsule.id === next.id ? next : capsule)))
    await store.save(next)
  }

  async function addPhoto(event: ChangeEvent<HTMLInputElement>, capsule: FamilyCapsule) {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (isCapsuleUnlocked(capsule.opensAt, clock)) {
      setAnnouncement('This Capsule is already open, so it can no longer receive photos.')
      return
    }

    setUploadingCapsuleId(capsule.id)
    setAnnouncement('Preparing your photo…')
    try {
      const capturedAt = await getCapsulePhotoCapturedAt(file)
      const processed = await processCapsuleImage(file)
      const latestCapsule = capsules.find(({ id }) => id === capsule.id) ?? capsule
      const caption = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
      const localPhotoId = createId('photo')
      const photo: CapsulePhoto = {
        id: localPhotoId,
        capsuleId: capsule.id,
        image: processed.image,
        thumbnail: processed.thumbnail,
        width: processed.width,
        height: processed.height,
        thumbnailWidth: processed.thumbnailWidth,
        thumbnailHeight: processed.thumbnailHeight,
        caption,
        capturedAt,
        contributorName: displayName,
        ownedByCurrentUser: true,
        syncStatus: 'pending',
      }
      await saveCapsule({
        ...latestCapsule,
        photos: [...latestCapsule.photos, photo],
        totalPhotoCount: (latestCapsule.totalPhotoCount ?? latestCapsule.photos.length) + 1,
      })
      const refreshed = await refreshCapsules()
      const synced = refreshed.capsules.some((candidate) => (
        candidate.photos.some((candidatePhoto) => (
          candidatePhoto.id === localPhotoId && candidatePhoto.syncStatus === 'synced'
        ))
      ))
      setAnnouncement(
        synced
          ? `${file.name} was shared with your family in ${capsuleDisplayTitle(capsule)}.`
          : `${file.name} is saved on this device and waiting to share with your family.`,
      )
    } catch (reason) {
      setAnnouncement(reason instanceof Error ? reason.message : 'That photo could not be added.')
    } finally {
      setUploadingCapsuleId('')
    }
  }

  async function createSpecialCapsule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const title = String(form.get('title') ?? '').trim()
    const openDate = String(form.get('openDate') ?? '')
    if (!title || !openDate) return

    const opensAt = new Date(`${openDate}T20:00:00`)
    if (Number.isNaN(opensAt.getTime())) {
      setAnnouncement('Choose a valid day for this Capsule to open.')
      return
    }
    const localCapsuleId = createId('capsule')
    const special: FamilyCapsule = {
      id: localCapsuleId,
      kind: 'special',
      title,
      createdAt: new Date().toISOString(),
      closesAt: opensAt.toISOString(),
      opensAt: opensAt.toISOString(),
      createdByName: displayName,
      photos: [],
      totalPhotoCount: 0,
      familySynced: false,
    }
    setCapsules((current) => orderCapsules([...current, special]))
    try {
      await store.save(special)
      const refreshed = await refreshCapsules()
      const synced = refreshed.capsules.some((capsule) => (
        capsule.id === localCapsuleId && capsule.familySynced === true
      ))
      setAnnouncement(
        synced
          ? `${title} is ready for family photos.`
          : `${title} is saved on this device and waiting to share with your family.`,
      )
    } catch {
      setAnnouncement('This Capsule could not be saved on this device.')
    } finally {
      setCreating(false)
    }
  }

  function openRecap(capsule: FamilyCapsule) {
    setDemoRecapId('')
    setActiveRecapId(capsule.id)
  }

  function openDemoRecap(capsule: FamilyCapsule) {
    setDemoRecapId(capsule.id)
    setActiveRecapId(capsule.id)
  }

  function closeRecap() {
    setActiveRecapId('')
    setDemoRecapId('')
  }

  const activeRecap = capsules.find(({ id }) => id === activeRecapId) ?? null
  const currentWeekly = capsules.find(({ id }) => id === authoritativeWeeklyId) ??
    capsules.find((capsule) => capsule.kind === 'weekly' && capsule.weekStart === weekKey)
  const completedWeeklyWithPhotos = capsules.filter((capsule) => (
    capsule.kind === 'weekly'
    && capsule.id !== currentWeekly?.id
    && isCapsuleUnlocked(capsule.opensAt, clock)
    && capsuleHasPhotos(capsule)
  ))
  const pastWeeklyRecaps = completedWeeklyWithPhotos
  const specialCapsules = capsules.filter((capsule) => capsule.kind === 'special')

  return (
    <section className="ks-feature capsules-page" aria-labelledby="capsules-title">
      <header className="ks-feature__header capsule-page-header app-page-header">
        <div className="ks-feature__header-copy">
          <p className="capsule-page-header__eyebrow app-page-header__eyebrow">Our family</p>
          <h1 id="capsules-title">Capsule</h1>
          <p className="app-page-header__subtitle">Small pieces of the week, opened together.</p>
        </div>
        <button
          className="ks-feature__header-action"
          type="button"
          aria-label={creating ? 'Close special Capsule form' : 'Create a special Capsule'}
          aria-expanded={creating}
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? '×' : '+'}
        </button>
      </header>

      <p className="capsule-page__announcement" role="status" aria-live="polite">{announcement}</p>

      {creating ? (
        <form className="capsule-special-form" onSubmit={(event) => void createSpecialCapsule(event)}>
          <div>
            <p>Special Capsule</p>
            <h2>Keep one occasion together</h2>
          </div>
          <label className="ks-field">
            <span>Name</span>
            <input name="title" autoFocus maxLength={64} placeholder="Grandpa’s 60th" required />
          </label>
          <label className="ks-field">
            <span>Open after</span>
            <input name="openDate" type="date" min={toLocalDateInput(addLocalDays(clock, 1))} defaultValue={toLocalDateInput(addLocalDays(clock, 7))} required />
          </label>
          <p>Everyone can add ordinary photos until 8:00 PM on this day.</p>
          <button className="ks-primary-button" type="submit">Create Capsule</button>
        </form>
      ) : null}

      {loading ? <p className="capsule-page__loading">Opening your family Capsule…</p> : null}

      {currentWeekly ? (
        <section className="capsule-page__section" aria-labelledby="weekly-capsule-title">
          <div className="capsule-section-heading">
            <div>
              <p>Weekly Capsule</p>
              <h2 id="weekly-capsule-title">Right now</h2>
            </div>
            <span>Photos only · not 360°</span>
          </div>
          <CapsuleCard
            capsule={currentWeekly}
            now={clock}
            uploading={uploadingCapsuleId === currentWeekly.id}
            demoUnlocked={demoRecapId === currentWeekly.id}
            onChoosePhoto={addPhoto}
            onOpenRecap={openRecap}
            onDemoUnlock={openDemoRecap}
          />
        </section>
      ) : null}

      {pastWeeklyRecaps.length > 0 ? (
        <section className="capsule-page__section" aria-labelledby="past-weekly-capsules-title">
          <div className="capsule-section-heading">
            <div>
              <p>Opened together</p>
              <h2 id="past-weekly-capsules-title">Past weeks</h2>
            </div>
            <span>Swipe · play · download</span>
          </div>
          <ul
            className="capsule-weekly-carousel"
            data-single={pastWeeklyRecaps.length === 1 ? 'true' : 'false'}
            aria-label="Past weekly recaps"
            tabIndex={0}
          >
            {pastWeeklyRecaps.map((capsule) => (
              <li key={capsule.id}>
                <CapsuleCard
                  capsule={capsule}
                  now={clock}
                  uploading={false}
                  demoUnlocked={demoRecapId === capsule.id}
                  onChoosePhoto={addPhoto}
                  onOpenRecap={openRecap}
                  onDemoUnlock={openDemoRecap}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="capsule-page__section" aria-labelledby="special-capsules-title">
        <div className="capsule-section-heading">
          <div>
            <p>Birthdays, weddings, reunions</p>
            <h2 id="special-capsules-title">Special Capsules</h2>
          </div>
          <button type="button" onClick={() => setCreating(true)}>New</button>
        </div>
        {specialCapsules.length > 0 ? specialCapsules.map((capsule) => (
          <CapsuleCard
            key={capsule.id}
            capsule={capsule}
            now={clock}
            uploading={uploadingCapsuleId === capsule.id}
            demoUnlocked={demoRecapId === capsule.id}
            onChoosePhoto={addPhoto}
            onOpenRecap={openRecap}
            onDemoUnlock={openDemoRecap}
          />
        )) : (
          <button className="capsule-special-empty" type="button" onClick={() => setCreating(true)}>
            <span aria-hidden="true">＋</span>
            <strong>Make a Capsule for the next big day</strong>
            <small>Grandpa’s 60th, Lea’s wedding, or anything your family calls special.</small>
          </button>
        )}
      </section>

      {activeRecap ? (
        <RecapSheet
          capsule={activeRecap}
          demoMode={demoRecapId === activeRecap.id}
          onClose={closeRecap}
          onPreparePhotos={async () => {
            const refreshed = await refreshCapsules()
            return refreshed.capsules.find(({ id }) => id === activeRecap.id)?.photos ?? []
          }}
        />
      ) : null}
    </section>
  )
}
