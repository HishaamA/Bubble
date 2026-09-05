import { MemoryConstellation } from '../../features/memories/MemoryConstellation'
import { PanoramaMemoryScreen } from '../../features/memories/PanoramaMemoryScreen'
import {
  useFamilyMomentSync,
  useSharedMoments,
} from '../../features/memories/shared'

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
