import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../features/auth'
import { Generative360Page } from '../../features/capture/Generative360Page'
import { AI_PANORAMA_DISCLOSURE } from '../../services/media/panoramaProvenance'
import {
  Capture360Page,
  type Capture360Submission,
  type CaptureSource,
} from '../../features/capture'
import {
  useFamilyMomentSync,
  useSharedMoments,
} from '../../features/memories/shared'

/** Compares calendar dates in the device's local timezone. */
function isSameLocalDay(first: string | Date, second: Date) {
  const date = first instanceof Date ? first : new Date(first)
  return (
    date.getFullYear() === second.getFullYear() &&
    date.getMonth() === second.getMonth() &&
    date.getDate() === second.getDate()
  )
}

/** Owns the native/web capture workflow and its save or share destinations. */
export function CaptureRoute() {
  const { user, isDevelopmentPreview } = useAuth()
  const captureOwnerKey = user ? `${isDevelopmentPreview ? 'demo' : 'clerk'}:${user.id}` : undefined
  const location = useLocation()
  const navigate = useNavigate()
  const { moments, saveMoment } = useSharedMoments()
  const { dailyWindow, shareMoment, status } = useFamilyMomentSync()
  const [delivery, setDelivery] = useState<'local' | 'family' | null>(null)
  const workflow = new URLSearchParams(location.search).get('workflow')
  const savedCaptureSessionIds = useMemo(() => moments
    .filter((moment) => moment.ownedByCurrentUser && moment.captureSessionId)
    .map((moment) => moment.captureSessionId!), [moments])
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
      provenance: submission.provenance,
      captureSessionId: submission.captureSessionId,
      uploaderDisplayName: 'You',
      ownedByCurrentUser: true,
      familySynced: false,
      annotations: submission.annotations,
      isDraft: true,
    })
  }

  /** New AI scenes are saved explicitly on this device, never automatically published. */
  async function saveGeneratedCapture(submission: Capture360Submission) {
    const title = submission.caption.endsWith(AI_PANORAMA_DISCLOSURE)
      ? submission.caption.slice(0, -AI_PANORAMA_DISCLOSURE.length).trimEnd()
      : submission.caption
    await saveMoment({
      id: submission.id,
      blob: submission.file,
      label: title || 'AI 360 scene',
      caption: submission.caption,
      createdAt: submission.createdAt,
      width: submission.width,
      height: submission.height,
      source: 'manual',
      provenance: submission.provenance,
      uploaderDisplayName: 'You',
      ownedByCurrentUser: true,
      familySynced: false,
      annotations: submission.annotations,
    })
  }

  if (workflow === 'ai' && captureOwnerKey) {
    return <Generative360Page
      key={captureOwnerKey}
      captureOwnerKey={captureOwnerKey}
      onClose={() => location.key === 'default' ? navigate('/', { replace: true }) : navigate(-1)}
      onLegacyCapture={() => navigate('/capture?mode=manual')}
      onViewMemories={() => navigate('/', { viewTransition: true })}
      onSave={saveGeneratedCapture}
    />
  }

  return (
    <Capture360Page
      key={`${captureOwnerKey ?? 'signed-out'}:${workflow === 'advanced' ? 'advanced' : 'standard'}`}
      captureOwnerKey={captureOwnerKey}
      assemblyMode={workflow === 'advanced' ? 'advanced' : 'standard'}
      savedCaptureSessionIds={savedCaptureSessionIds}
      onOpenAiGeneration={() => navigate('/capture?workflow=ai')}
      onOpenAdvancedAssembly={workflow !== 'advanced' ? () => navigate('/capture?workflow=advanced') : undefined}
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
