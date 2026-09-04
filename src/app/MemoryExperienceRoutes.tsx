import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Capture360Page,
  type Capture360Submission,
  type CaptureSource,
} from '../features/capture'
import { CapsulePhotoViewer } from '../features/journal/CapsulePhotoViewer'
import { useJournalCapsuleArchive } from '../features/journal/capsuleJournalArchive'
import { withDemoJournalPhotos } from '../features/journal/demoJournalPhotos'
import { useJournalPhotoLibrary } from '../features/journal/journalPhotoLibrary'
import type {
  JournalPhoto,
  JournalPhotoStore,
} from '../features/journal/journalPhotoTypes'
import { JournalPage } from '../features/journal'
import type {
  CapsuleStore,
  FamilyCapsule,
} from '../features/capsules/types'
import { MemoryConstellation } from '../features/memories/MemoryConstellation'
import { PanoramaMemoryScreen } from '../features/memories/PanoramaMemoryScreen'
import {
  useFamilyMomentSync,
  useSharedMoments,
} from '../features/memories/shared'
import { useAuth } from '../features/auth'

/** Compares calendar dates in the device's local timezone. */
function isSameLocalDay(first: string | Date, second: Date) {
  const date = first instanceof Date ? first : new Date(first)
  return (
    date.getFullYear() === second.getFullYear() &&
    date.getMonth() === second.getMonth() &&
    date.getDate() === second.getDate()
  )
}

/** Connects the Moments constellation to shared-memory synchronization. */
export function MemoriesRoute() {
  const { moments } = useSharedMoments()
  const { deleteMoment } = useFamilyMomentSync()

  return (
    <MemoryConstellation
      sharedMoments={moments}
      onDelete360={deleteMoment}
    />
  )
}

type JournalArchiveRouteProps = {
  now?: Date
  capsules?: FamilyCapsule[]
  capsuleStore?: CapsuleStore
  capsuleCacheNamespace?: string
  journalPhotos?: JournalPhoto[]
  journalPhotoStore?: JournalPhotoStore
}

/**
 * Loads the capsule archive and photo library shared by both Journal routes.
 * Keeping this wiring in one hook prevents the list and full-screen viewer
 * from drifting into different cache, demo, or contributor behavior.
 */
function useJournalRouteData({
  now,
  capsules: suppliedCapsules,
  capsuleStore,
  capsuleCacheNamespace = 'signed-out:no-family',
  journalPhotos: suppliedJournalPhotos,
  journalPhotoStore,
}: JournalArchiveRouteProps) {
  const { isDevelopmentPreview, user } = useAuth()
  const archive = useJournalCapsuleArchive({
    cacheNamespace: capsuleCacheNamespace,
    enabled: suppliedCapsules === undefined,
    store: capsuleStore,
  })
  const photoLibrary = useJournalPhotoLibrary({
    cacheNamespace: capsuleCacheNamespace,
    contributorName: user?.displayName?.trim() || 'You',
    enabled: suppliedJournalPhotos === undefined,
    store: journalPhotoStore,
  })
  const journalPhotos = useMemo(
    () => withDemoJournalPhotos(
      suppliedJournalPhotos ?? photoLibrary.photos,
      isDevelopmentPreview === true,
    ),
    [isDevelopmentPreview, photoLibrary.photos, suppliedJournalPhotos],
  )

  return {
    capsules: suppliedCapsules ?? archive.capsules,
    journalPhotos,
    loading:
      (suppliedCapsules === undefined && archive.loading) ||
      (suppliedJournalPhotos === undefined && photoLibrary.loading),
    now: now ?? archive.clock,
    openAllPhotosByDefault: isDevelopmentPreview === true,
    photoLibrary,
  }
}

/** Displays the combined photo timeline, plans, and flights Journal page. */
export function JournalRoute({
  now,
  capsules: suppliedCapsules,
  capsuleStore,
  capsuleCacheNamespace = 'signed-out:no-family',
  journalPhotos: suppliedJournalPhotos,
  journalPhotoStore,
}: JournalArchiveRouteProps = {}) {
  const routeData = useJournalRouteData({
    now,
    capsules: suppliedCapsules,
    capsuleStore,
    capsuleCacheNamespace,
    journalPhotos: suppliedJournalPhotos,
    journalPhotoStore,
  })

  return (
    <JournalPage
      now={now}
      capsules={routeData.capsules}
      capsuleNow={routeData.now}
      capsuleCacheNamespace={capsuleCacheNamespace}
      journalPhotos={routeData.journalPhotos}
      onUploadJournalPhotos={routeData.photoLibrary.importPhotos}
      journalPhotoImportProgress={routeData.photoLibrary.importProgress}
      openAllPhotosByDefault={routeData.openAllPhotosByDefault}
    />
  )
}

/** Displays one capsule or library image without duplicating Journal loading. */
export function CapsulePhotoRoute({
  now,
  capsules: suppliedCapsules,
  capsuleStore,
  capsuleCacheNamespace = 'signed-out:no-family',
  journalPhotos: suppliedJournalPhotos,
  journalPhotoStore,
}: JournalArchiveRouteProps = {}) {
  const routeData = useJournalRouteData({
    now,
    capsules: suppliedCapsules,
    capsuleStore,
    capsuleCacheNamespace,
    journalPhotos: suppliedJournalPhotos,
    journalPhotoStore,
  })

  return (
    <CapsulePhotoViewer
      capsules={routeData.capsules}
      loading={routeData.loading}
      now={routeData.now}
      journalPhotos={routeData.journalPhotos}
    />
  )
}

/** Connects a selected 360 memory to the panorama viewer and annotations. */
export function PanoramaRoute() {
  const { loading, moments } = useSharedMoments()
  const { updateMomentAnnotations } = useFamilyMomentSync()

  return (
    <PanoramaMemoryScreen
      sharedMoments={moments}
      sharedMomentsLoading={loading}
      onUpdateMomentAnnotations={(moment, annotations) =>
        updateMomentAnnotations(moment.id, annotations)}
    />
  )
}

/** Owns the native/web capture workflow and its save or share destinations. */
export function CaptureRoute() {
  const location = useLocation()
  const navigate = useNavigate()
  const { moments, saveMoment } = useSharedMoments()
  const { dailyWindow, shareMoment, status } = useFamilyMomentSync()
  const [delivery, setDelivery] = useState<'local' | 'family' | null>(null)
  const requestedMode = new URLSearchParams(location.search).get('mode')
  const initialMode: CaptureSource =
    requestedMode === 'daily' ? 'daily' : 'manual'
  const today = new Date()
  const dailyCaptureCompleted = moments.some(
    (moment) =>
      moment.source === 'daily' &&
      moment.isDraft !== true &&
      moment.uploaderDisplayName === 'You' &&
      isSameLocalDay(moment.createdAt, today),
  )

  /** Shares a completed capture and records where it was delivered. */
  async function saveCapture(submission: Capture360Submission) {
    const result = await shareMoment(submission)
    setDelivery(result.delivery)
  }

  /** Persists an unfinished capture locally without starting family sync. */
  async function saveCaptureDraft(submission: Capture360Submission) {
    await saveMoment({
      id: submission.id,
      blob: submission.file,
      label: 'Autosaved 360 sphere',
      caption: '',
      createdAt: submission.createdAt,
      width: submission.width,
      height: submission.height,
      source: submission.source,
      uploaderDisplayName: 'You',
      ownedByCurrentUser: true,
      familySynced: false,
      annotations: submission.annotations,
      isDraft: true,
    })
  }

  return (
    <Capture360Page
      initialMode={initialMode}
      connectedFamilySync={status === 'connected'}
      dailyWindow={dailyWindow ?? undefined}
      dailyCaptureCompleted={dailyCaptureCompleted}
      familySeed="ahmed-family-demo"
      onClose={() =>
        location.key === 'default'
          ? navigate('/', { replace: true })
          : navigate(-1)
      }
      onViewMemories={() => navigate('/', { viewTransition: true })}
      onSaveDraft={saveCaptureDraft}
      onShare={saveCapture}
      successMessage={
        delivery === 'family'
          ? 'Shared securely. Approved family members will receive this bubble in Memories.'
          : 'Added to Memories on this device. Sign in to a Family Circle to deliver it to other phones.'
      }
    />
  )
}
