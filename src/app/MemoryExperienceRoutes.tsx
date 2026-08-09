import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Capture360Page,
  type Capture360Submission,
  type CaptureSource,
} from '../features/capture'
import { JournalPage } from '../features/journal'
import { MemoryConstellation } from '../features/memories/MemoryConstellation'
import { PanoramaMemoryScreen } from '../features/memories/PanoramaMemoryScreen'
import {
  useFamilyMomentSync,
  useSharedMoments,
} from '../features/memories/shared'

function isSameLocalDay(first: string | Date, second: Date) {
  const date = first instanceof Date ? first : new Date(first)
  return (
    date.getFullYear() === second.getFullYear() &&
    date.getMonth() === second.getMonth() &&
    date.getDate() === second.getDate()
  )
}

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

export function JournalRoute({ now }: { now?: Date } = {}) {
  const { moments } = useSharedMoments()

  return <JournalPage now={now} sharedMoments={moments} />
}

export function PanoramaRoute() {
  const { loading, moments } = useSharedMoments()

  return (
    <PanoramaMemoryScreen
      sharedMoments={moments}
      sharedMomentsLoading={loading}
    />
  )
}

export function CaptureRoute() {
  const location = useLocation()
  const navigate = useNavigate()
  const { moments } = useSharedMoments()
  const { dailyWindow, shareMoment, status } = useFamilyMomentSync()
  const [delivery, setDelivery] = useState<'local' | 'family' | null>(null)
  const requestedMode = new URLSearchParams(location.search).get('mode')
  const initialMode: CaptureSource =
    requestedMode === 'daily' ? 'daily' : 'manual'
  const today = new Date()
  const dailyCaptureCompleted = moments.some(
    (moment) =>
      moment.source === 'daily' &&
      moment.uploaderDisplayName === 'You' &&
      isSameLocalDay(moment.createdAt, today),
  )

  async function saveCapture(submission: Capture360Submission) {
    const result = await shareMoment(submission)
    setDelivery(result.delivery)
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
      onShare={saveCapture}
      successMessage={
        delivery === 'family'
          ? 'Shared securely. Approved family members will receive this bubble in Memories.'
          : 'Added to Memories on this device. Sign in to a Family Circle to deliver it to other phones.'
      }
    />
  )
}
