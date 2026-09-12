import { useMemo } from 'react'
import { removeCapsuleContent } from '../../features/capsules/capsuleRemovalActions'
import type {
  CapsuleStore,
  FamilyCapsule,
} from '../../features/capsules/types'
import { useAuth } from '../../features/auth'
import { CapsulePhotoViewer } from '../../features/journal/CapsulePhotoViewer'
import { useJournalCapsuleArchive } from '../../features/journal/capsuleJournalArchive'
import { withDemoJournalPhotos } from '../../features/journal/demoJournalPhotos'
import { JournalPage } from '../../features/journal'
import { useJournalPhotoLibrary } from '../../features/journal/journalPhotoLibrary'
import type {
  JournalPhoto,
  JournalPhotoStore,
} from '../../features/journal/journalPhotoTypes'

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
      onDeleteJournalPhoto={routeData.photoLibrary.deletePhoto}
      onDeleteCapsulePhoto={async (capsuleId, photoId) => {
        const capsule = routeData.capsules.find(({ id }) => id === capsuleId)
        if (!capsule) throw new Error('This Capsule is no longer available. Please refresh Journal.')
        await removeCapsuleContent({ scope: capsuleCacheNamespace, capsule, photoId, store: capsuleStore })
      }}
      journalPhotoImportProgress={routeData.photoLibrary.importProgress}
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
      reactionStorageScope={capsuleCacheNamespace}
      capsules={routeData.capsules}
      loading={routeData.loading}
      now={routeData.now}
      journalPhotos={routeData.journalPhotos}
    />
  )
}
