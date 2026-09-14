import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import '../FeaturePages.css'
import './Capture360Page.css'
import {
  createDailyCaptureWindow,
  getDailyCapturePhase,
  type DailyCaptureWindow,
} from './captureWindow'
import {
  readImageDimensions,
  validatePanoramaCaptureDimensions,
  type ImageDimensions,
} from './equirectangular'
import {
  processPanoramaForSharing,
  type ProcessedPanorama,
} from '../../services/media/processPanorama'
import type { StoredPanoramaAnnotation } from '../memories/shared'
import { composeGuidedPanorama, type GuidedPanoramaProgress } from '../../services/media/composeGuidedPanorama'
import { GuidedCapturePreview } from './GuidedCapturePreview'
import { GuidedPanoramaReview } from './GuidedPanoramaReview'
import {
  discardNativePanoramaCapture,
  isNativeCaptureCancellation,
  isNativePanoramaCaptureAvailable,
  startNativePanoramaCapture,
  type NativePanoramaCaptureOptions,
  type NativePanoramaCaptureResult,
} from './nativePanoramaCapture'
import { installCaptureEditorViewportSync } from './captureEditorViewport'
import { CaptureDraftEditor } from './CaptureDraftEditor'
import { CaptureStartPanel } from './CaptureStartPanel'
import { CaptureIcon } from './CaptureIcon'

import type { CaptureSource, Capture360Submission } from './captureTypes'
export type { CaptureSource, Capture360Submission } from './captureTypes'
import {
  aiPanoramaProgressLabel,
  assembleAiNativePanorama,
  assembleAiPhotoPanorama,
  checkAiPanoramaHealth,
  isAiPanoramaCancellation,
  type AiPanoramaHealth,
  type AiPanoramaProgress,
  type AiProcessedPanorama,
} from '../../services/media/aiPanorama'
import {
  assembleNativePanorama,
  getNativePanoramaStitchStatus,
  getSavedNativeCaptures,
  isCompleteNativeCapture,
  isNativePanoramaMemoryFailure,
  nativeStitchProgressLabel,
  openSavedNativePanorama,
  usesNativePanoramaStitch,
  type NativeStitchProgress,
  type NativeStitchStatus,
  type SavedNativeCapture,
} from '../../services/media/nativePanoramaStitch'

type Capture360PageProps = {
  now?: Date
  dailyWindow?: DailyCaptureWindow
  familySeed?: string
  /** Stable authenticated identity; recovery never crosses account boundaries. */
  captureOwnerKey?: string
  /** Standard is the shared on-phone compositor; advanced keeps strict alignment. */
  assemblyMode?: 'standard' | 'advanced'
  savedCaptureSessionIds?: readonly string[]
  dailyCaptureCompleted?: boolean
  initialMode?: CaptureSource
  connectedFamilySync?: boolean
  onClose?: () => void
  onViewMemories?: () => void
  onOpenAiGeneration?: () => void
  onOpenAdvancedAssembly?: () => void
  onSaveDraft?: (submission: Capture360Submission) => void | Promise<void>
  onShare?: (submission: Capture360Submission) => void | Promise<void>
  readDimensions?: (file: File) => Promise<ImageDimensions>
  processPanorama?: (file: File) => Promise<ProcessedPanorama>
  guidedCaptureAvailable?: boolean
  startGuidedCapture?: (options?: NativePanoramaCaptureOptions) => Promise<NativePanoramaCaptureResult>
  discardGuidedCapture?: (result: NativePanoramaCaptureResult) => Promise<void>
  composeGuidedCapture?: (
    result: NativePanoramaCaptureResult,
    onProgress?: (progress: GuidedPanoramaProgress) => void,
    outputWidth?: number,
    signal?: AbortSignal,
  ) => Promise<ProcessedPanorama>
  successMessage?: string
}

type CaptureDraft = {
  id: string
  createdAt: Date
  file: File
  dimensions: ImageDimensions
  previewUrl: string
  source: CaptureSource
  origin: 'guided' | 'upload' | 'ai'
  savedLocally: boolean
  nativeCaptureResult?: NativePanoramaCaptureResult
  picker?: 'camera' | 'library'
  warning?: string
}

// Raw images remain in native storage; this registry holds only their
// session metadata and never returns one account's capture to another account.
const recoverableNativeCaptures = new Map<string, {
  result: NativePanoramaCaptureResult
  saving?: Promise<void>
}>()
const NO_SAVED_CAPTURE_SESSIONS: readonly string[] = []
const LEGACY_TRACKING_WARNING = 'These photos use older Android tracking coordinates. Tracking drift can produce misplaced or patchwork views; blending cannot repair it. A new capture is recommended. Your originals are kept.'

function hasLegacyAndroidTracking(capture: NativePanoramaCaptureResult) {
  return capture.frames.some((frame) => frame.poseSource === 'arcoreDisplayOrientedPose')
}

function hasRunningNativeAssembly(capture: SavedNativeCapture) {
  return capture.assembly?.state === 'queued' || capture.assembly?.state === 'running'
}

/** Creates a UUID for drafts before either local or family persistence begins. */
function makeSubmissionId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16)
      const value = character === 'x' ? random : (random & 0x3) | 0x8
      return value.toString(16)
    })
  )
}

/**
 * Coordinates daily/manual panorama intake, native guided capture, browser
 * validation, draft recovery, annotation review, and final family delivery.
 */
export function Capture360Page({
  now,
  dailyWindow,
  familySeed,
  captureOwnerKey,
  assemblyMode = 'standard',
  savedCaptureSessionIds = NO_SAVED_CAPTURE_SESSIONS,
  dailyCaptureCompleted = false,
  initialMode = 'daily',
  connectedFamilySync = false,
  onClose,
  onViewMemories,
  onOpenAiGeneration,
  onOpenAdvancedAssembly,
  onSaveDraft,
  onShare,
  readDimensions = readImageDimensions,
  processPanorama = processPanoramaForSharing,
  guidedCaptureAvailable = isNativePanoramaCaptureAvailable(),
  startGuidedCapture = startNativePanoramaCapture,
  discardGuidedCapture = discardNativePanoramaCapture,
  composeGuidedCapture,
  successMessage,
}: Capture360PageProps) {
  const nativeRecovery = usesNativePanoramaStitch()
  const advancedNativeAssembly = nativeRecovery && assemblyMode === 'advanced'
  const computerAssembly = !nativeRecovery && assemblyMode === 'advanced'
  const savedCaptureSessions = useMemo(() => new Set(savedCaptureSessionIds), [savedCaptureSessionIds])
  const [clock, setClock] = useState(() => new Date())
  const [source, setSource] = useState<CaptureSource>(initialMode)
  const [draft, setDraft] = useState<CaptureDraft | null>(null)
  const [caption, setCaption] = useState('')
  const [annotations, setAnnotations] = useState<StoredPanoramaAnnotation[]>([])
  const [reviewingPanorama, setReviewingPanorama] = useState(false)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shared, setShared] = useState(false)
  const [completedDaily, setCompletedDaily] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [guidePreview, setGuidePreview] = useState(false)
  const [guidedCaptureRunning, setGuidedCaptureRunning] = useState(false)
  const [guidedCaptureStatus, setGuidedCaptureStatus] = useState('')
  const [aiHealth, setAiHealth] = useState<AiPanoramaHealth | null>(null)
  const [aiAssembling, setAiAssembling] = useState(false)
  const [sharedAssembling, setSharedAssembling] = useState(false)
  const [aiProgress, setAiProgress] = useState<AiPanoramaProgress | null>(null)
  const [nativeStitchStatus, setNativeStitchStatus] = useState<NativeStitchStatus | null>(null)
  const [nativeProgress, setNativeProgress] = useState<NativeStitchProgress | null>(null)
  const [savedCaptures, setSavedCaptures] = useState<SavedNativeCapture[]>(() => {
    const capture = captureOwnerKey ? recoverableNativeCaptures.get(captureOwnerKey)?.result : undefined
    return capture ? [capture] : []
  })
  const [savedCaptureStatusError, setSavedCaptureStatusError] = useState('')
  const [removeOriginals, setRemoveOriginals] = useState<SavedNativeCapture | null>(null)
  const [acknowledgedAssemblyRemoval, setAcknowledgedAssemblyRemoval] = useState(false)
  const [memoryRetryCapture, setMemoryRetryCapture] = useState<NativePanoramaCaptureResult | null>(null)
  const [loadingOriginals, setLoadingOriginals] = useState(nativeRecovery && Boolean(captureOwnerKey))
  const [hasPendingCapture, setHasPendingCapture] = useState(() => Boolean(captureOwnerKey && recoverableNativeCaptures.has(captureOwnerKey)))
  const aiAbortRef = useRef<AbortController | null>(null)
  const nativeDetachRef = useRef<AbortController | null>(null)
  const sharedAbortRef = useRef<AbortController | null>(null)
  const pendingNativeCaptureRef = useRef<NativePanoramaCaptureResult | null>(captureOwnerKey ? recoverableNativeCaptures.get(captureOwnerKey)?.result ?? null : null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  const aiPhotosInputRef = useRef<HTMLInputElement>(null)
  const capturePageRef = useRef<HTMLElement>(null)
  const captionInputRef = useRef<HTMLTextAreaElement>(null)
  const sourceRef = useRef<CaptureSource>(initialMode)
  const pickerRef = useRef<'camera' | 'library'>('library')
  const previewUrlRef = useRef<string | null>(null)
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const draftSaveVersionRef = useRef(0)
  const draftSaveUiRequestRef = useRef(0)
  const draftSaveInFlightRef = useRef(false)
  const guidedCaptureInFlightRef = useRef(false)
  const guidedCaptureRequestRef = useRef(0)
  const fileSelectionInFlightRef = useRef(false)
  const fileSelectionRequestRef = useRef(0)
  const shareInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const restoreGuideFocusRef = useRef(false)
  const guidedCaptureButtonRef = useRef<HTMLButtonElement>(null)
  const visibleSavedCaptures = nativeRecovery
    ? savedCaptures.filter((capture) => capture.ownerKey === captureOwnerKey)
    : savedCaptures
  const recoveredRunningJobsKey = visibleSavedCaptures
    .filter((capture) => capture.assembly?.state === 'queued' || capture.assembly?.state === 'running')
    .map((capture) => `${capture.directoryUrl}:${capture.assembly?.jobId ?? ''}`).join('|')

  useEffect(() => {
    if (!computerAssembly) return
    const controller = new AbortController()
    void checkAiPanoramaHealth({ signal: controller.signal })
      .then((health) => { if (!controller.signal.aborted) setAiHealth(health) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [computerAssembly])

  useEffect(() => {
    if (!advancedNativeAssembly) return
    let active = true
    const controller = new AbortController()
    void getNativePanoramaStitchStatus({ signal: controller.signal }).then((status) => {
      if (active) setNativeStitchStatus(status)
    }).catch(() => {
      if (active) setNativeStitchStatus({ available: false, offline: true, model: 'DISK + LightGlue' })
    })
    return () => { active = false; controller.abort() }
  }, [advancedNativeAssembly])

  useEffect(() => {
    if (!nativeRecovery) return
    let active = true
    const controller = new AbortController()
    if (!captureOwnerKey) {
      return () => { active = false; controller.abort() }
    }
    // Memories hydrate after this page mounts. Do not keep offering an already
    // saved source set as unfinished, but never detach an active native job.
    const previousPending = pendingNativeCaptureRef.current as SavedNativeCapture | null
    if (previousPending?.sessionId && savedCaptureSessions.has(previousPending.sessionId)
      && !hasRunningNativeAssembly(previousPending) && !guidedCaptureInFlightRef.current
      && !recoverableNativeCaptures.get(captureOwnerKey)?.saving) {
      pendingNativeCaptureRef.current = null
      recoverableNativeCaptures.delete(captureOwnerKey)
      setHasPendingCapture(false)
    }
    void getSavedNativeCaptures(captureOwnerKey, { signal: controller.signal }).then((captures) => {
      if (!active) return
      setSavedCaptures(captures)
      setSavedCaptureStatusError('')
      const previous = pendingNativeCaptureRef.current
      const latest = previous && captures.find((capture) => capture.ownerKey === captureOwnerKey
        && capture.directoryUrl === previous.directoryUrl)
      if (latest && !guidedCaptureInFlightRef.current && !recoverableNativeCaptures.get(captureOwnerKey)?.saving) {
        if (!hasRunningNativeAssembly(latest) && (latest.assembly?.state === 'completed'
          || latest.savedResult?.state === 'completed'
          || (assemblyMode === 'standard' && latest.assembly?.state === 'failed')
          || (assemblyMode === 'standard' && hasLegacyAndroidTracking(latest))
          || (latest.sessionId && savedCaptureSessions.has(latest.sessionId)))) {
          pendingNativeCaptureRef.current = null
          recoverableNativeCaptures.delete(captureOwnerKey)
          setHasPendingCapture(false)
        } else {
          pendingNativeCaptureRef.current = latest
          recoverableNativeCaptures.set(captureOwnerKey, { result: latest })
        }
      }
      const pending = captures.find((capture) => isCompleteNativeCapture(capture)
        && capture.ownerKey === captureOwnerKey
        && capture.assembly?.state !== 'completed' && capture.savedResult?.state !== 'completed'
        && (assemblyMode !== 'standard' || capture.assembly?.state !== 'failed')
        && (assemblyMode !== 'standard' || hasRunningNativeAssembly(capture) || !hasLegacyAndroidTracking(capture))
        && (hasRunningNativeAssembly(capture) || !capture.sessionId || !savedCaptureSessions.has(capture.sessionId)))
      if (pending && !pendingNativeCaptureRef.current && !guidedCaptureInFlightRef.current) {
        pendingNativeCaptureRef.current = pending
        recoverableNativeCaptures.set(captureOwnerKey, { result: pending })
        setHasPendingCapture(true)
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Saved originals could not be loaded. Reopen Capture to try again.')
    }).finally(() => { if (active) setLoadingOriginals(false) })
    return () => { active = false; controller.abort() }
  }, [assemblyMode, captureOwnerKey, nativeRecovery, savedCaptureSessions])

  // A foreground page can observe a job started before this mount. Read its durable
  // status without restarting inference, opening a result, or cancelling the worker.
  useEffect(() => {
    if (!nativeRecovery || !captureOwnerKey || !recoveredRunningJobsKey || guidedCaptureRunning) return
    let active = true
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pendingRead: AbortController | undefined
    const schedule = () => {
      if (active && !document.hidden) timer = setTimeout(() => void refresh(), 2_000)
    }
    const refresh = async () => {
      if (!active || document.hidden || reading) return
      reading = true
      const controller = new AbortController()
      pendingRead = controller
      let continuePolling = false
      try {
        const captures = await getSavedNativeCaptures(captureOwnerKey, { signal: controller.signal })
        if (!active || controller.signal.aborted) return
        setSavedCaptures(captures)
        setSavedCaptureStatusError('')
        continuePolling = captures.some((capture) => capture.ownerKey === captureOwnerKey
          && (capture.assembly?.state === 'queued' || capture.assembly?.state === 'running'))
      } catch (reason) {
        if (!active) return
        if (controller.signal.aborted) continuePolling = true
        else {
          // Stop automatic retries on a failed status channel. The worker remains independent.
          setSavedCaptureStatusError(reason instanceof Error ? reason.message
            : 'Saved status could not be refreshed. Assembly may still be running; reopen Capture to check again.')
        }
      } finally {
        reading = false
        if (continuePolling) schedule()
      }
    }
    const visibilityChanged = () => {
      clearTimeout(timer)
      if (document.hidden) pendingRead?.abort()
      else void refresh()
    }
    schedule()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      active = false
      clearTimeout(timer)
      pendingRead?.abort()
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [captureOwnerKey, guidedCaptureRunning, nativeRecovery, recoveredRunningJobsKey])

  // A supplied clock freezes time for tests; production checks frequently enough
  // for a 15-minute capture window to open and close without user navigation.
  useEffect(() => {
    if (now) return

    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [now])

  // Request counters invalidate unresolved native/browser work on unmount. Only
  // the installed draft owns the persistent preview URL released here.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sharedAbortRef.current?.abort()
      if (nativeDetachRef.current) nativeDetachRef.current.abort()
      else aiAbortRef.current?.abort()
      guidedCaptureRequestRef.current += 1
      fileSelectionRequestRef.current += 1
      guidedCaptureInFlightRef.current = false
      fileSelectionInFlightRef.current = false
      draftSaveInFlightRef.current = false
      shareInFlightRef.current = false
      // This component owns the one installed draft URL. Async candidates do
      // not become owned until their request identity is still current.
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [nativeRecovery])

  // The shared app coordinator reveals focused fields. Capture additionally
  // tracks a compact breakpoint so its preview and actions fit the keyboard-
  // adjusted height without installing a second focus-scroll loop.
  useEffect(() => {
    if (!draft || reviewingPanorama || shared) return

    const capturePage = capturePageRef.current
    if (!capturePage) return

    return installCaptureEditorViewportSync(capturePage)
  }, [draft, reviewingPanorama, shared])

  const currentTime = now ?? clock
  const captureWindow = useMemo(
    () => dailyWindow ?? createDailyCaptureWindow(currentTime, familySeed),
    [currentTime, dailyWindow, familySeed],
  )
  const dailyCompleted = dailyCaptureCompleted || completedDaily
  const phase = getDailyCapturePhase(currentTime, captureWindow, dailyCompleted)
  const canUseDailyWindow = phase === 'open'
  const isSuccess = shared
  const interactionBusy = checking || guidedCaptureRunning || savingDraft || sharing || loadingOriginals
  const needsAssemblyRemovalAcknowledgement = (removeOriginals?.savedResult?.state === 'completed' || removeOriginals?.assembly?.state === 'completed')
    && !(draft?.savedLocally && draft.nativeCaptureResult?.directoryUrl === removeOriginals.directoryUrl)

  /** Reads synchronous mutexes that close React's pre-render double-action window. */
  function hasBlockingInteraction() {
    return (
      guidedCaptureInFlightRef.current ||
      fileSelectionInFlightRef.current ||
      draftSaveInFlightRef.current ||
      shareInFlightRef.current
      || loadingOriginals
    )
  }

  function retainNativeCapture(result: NativePanoramaCaptureResult) {
    if (captureOwnerKey && recoverableNativeCaptures.get(captureOwnerKey)?.result !== result) {
      recoverableNativeCaptures.set(captureOwnerKey, { result })
    }
    pendingNativeCaptureRef.current = result
    if (mountedRef.current) {
      setHasPendingCapture(true)
      setSavedCaptures((current) => [result, ...current.filter((capture) => capture.directoryUrl !== result.directoryUrl)])
    }
  }

  function releaseNativeRecovery(result: NativePanoramaCaptureResult) {
    if (captureOwnerKey && recoverableNativeCaptures.get(captureOwnerKey)?.result === result) {
      recoverableNativeCaptures.delete(captureOwnerKey)
    }
    if (pendingNativeCaptureRef.current === result) pendingNativeCaptureRef.current = null
    if (mountedRef.current) setHasPendingCapture(Boolean(pendingNativeCaptureRef.current))
  }

  /** Releases the browser preview; original photos remain available for retry. */
  function clearDraft({ invalidateFileSelection = true } = {}) {
    if (invalidateFileSelection) {
      fileSelectionRequestRef.current += 1
      fileSelectionInFlightRef.current = false
      setChecking(false)
    }
    const nativeCaptureResult = draft?.nativeCaptureResult
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setDraft(null)
    setCaption('')
    setAnnotations([])
    setReviewingPanorama(false)
    setError('')
    if (cameraInputRef.current) cameraInputRef.current.value = ''
    if (libraryInputRef.current) libraryInputRef.current.value = ''
    if (aiPhotosInputRef.current) aiPhotosInputRef.current.value = ''
    if (nativeCaptureResult) {
      releaseNativeRecovery(nativeCaptureResult)
    }
  }

  /** Opens the requested system picker only when its capture mode is currently valid. */
  function openPicker(
    nextSource: CaptureSource,
    picker: 'camera' | 'library' = 'library',
  ) {
    if (hasBlockingInteraction()) return
    if (nextSource === 'daily' && !canUseDailyWindow) return
    sourceRef.current = nextSource
    pickerRef.current = picker
    setSource(nextSource)
    setShared(false)
    setError('')
    const input = picker === 'camera' ? cameraInputRef : libraryInputRef
    input.current?.click()
  }

  /** Transfers ownership of a validated File and its new object URL into editor state. */
  function installDraft(
    file: File,
    dimensions: ImageDimensions,
    selectedSource: CaptureSource,
    origin: CaptureDraft['origin'],
    warning?: string,
    nativeCaptureResult?: NativePanoramaCaptureResult,
  ) {
    // The currently installed draft exclusively owns previewUrlRef. Request
    // identity checks happen before this function so a stale async selection
    // can never revoke the newer draft's URL.
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const previewUrl = URL.createObjectURL(file)
    previewUrlRef.current = previewUrl
    setSource(selectedSource)
    const nextDraft: CaptureDraft = {
      id: makeSubmissionId(),
      createdAt: new Date(),
      file,
      dimensions,
      previewUrl,
      source: selectedSource,
      origin,
      savedLocally: false,
      nativeCaptureResult,
      picker: origin === 'upload' ? pickerRef.current : undefined,
      warning,
    }
    setDraft(nextDraft)
    setAnnotations([])
    setReviewingPanorama(true)
    return nextDraft
  }

  /** Converts editor state to the persistence callback's immutable value object. */
  function createDraftSubmission(
    selectedDraft: CaptureDraft,
    nextCaption = '',
    nextAnnotations: StoredPanoramaAnnotation[] = [],
  ): Capture360Submission {
    return {
      id: selectedDraft.id,
      file: selectedDraft.file,
      caption: nextCaption,
      source: selectedDraft.source,
      width: selectedDraft.dimensions.width,
      height: selectedDraft.dimensions.height,
      createdAt: selectedDraft.createdAt,
      annotations: nextAnnotations,
      ...(selectedDraft.nativeCaptureResult?.sessionId ? { captureSessionId: selectedDraft.nativeCaptureResult.sessionId } : {}),
    }
  }

  /** Queues local saves so older callbacks cannot overwrite a newer editor version. */
  async function saveDraftLocally(
    selectedDraft: CaptureDraft,
    nextCaption = '',
    nextAnnotations: StoredPanoramaAnnotation[] = [],
  ) {
    if (!onSaveDraft) return

    const saveVersion = ++draftSaveVersionRef.current
    const submission = createDraftSubmission(
      selectedDraft,
      nextCaption,
      nextAnnotations,
    )
    const saveOperation = draftSaveQueueRef.current
      .catch(() => undefined)
      .then(() => onSaveDraft(submission))
    draftSaveQueueRef.current = saveOperation
    const recovery = captureOwnerKey ? recoverableNativeCaptures.get(captureOwnerKey) : undefined
    if (recovery && recovery.result === selectedDraft.nativeCaptureResult) recovery.saving = saveOperation

    try {
      await saveOperation
      if (selectedDraft.nativeCaptureResult) {
        releaseNativeRecovery(selectedDraft.nativeCaptureResult)
      }
      setDraft((currentDraft) =>
        currentDraft?.id === selectedDraft.id
          ? {
              ...currentDraft,
              savedLocally:
                saveVersion === draftSaveVersionRef.current
                  ? true
                  : currentDraft.savedLocally,
            }
          : currentDraft,
      )
    } catch (reason) {
      if (recovery?.saving === saveOperation) recovery.saving = undefined
      if (saveVersion === draftSaveVersionRef.current) {
        setDraft((currentDraft) =>
          currentDraft?.id === selectedDraft.id
            ? { ...currentDraft, savedLocally: false }
            : currentDraft,
        )
      }
      throw reason
    }
  }

  /** Replays the current draft after a user-visible local persistence failure. */
  async function retryDraftSave() {
    if (!draft || !onSaveDraft || draftSaveInFlightRef.current) return

    const uiRequest = ++draftSaveUiRequestRef.current
    draftSaveInFlightRef.current = true
    setSavingDraft(true)
    setError('')
    try {
      await saveDraftLocally(draft, caption.trim(), annotations)
      setAnnouncement('Your assembled 360° sphere is saved safely in Memories.')
    } catch {
      const message = 'Your sphere is still here, but it could not be saved yet. Check free space, then try again.'
      setError(message)
      setAnnouncement(message)
    } finally {
      if (uiRequest === draftSaveUiRequestRef.current) {
        draftSaveInFlightRef.current = false
        setSavingDraft(false)
      }
    }
  }

  /** Applies review edits immediately and serializes their background persistence. */
  function updateAnnotations(nextAnnotations: StoredPanoramaAnnotation[]) {
    setAnnotations(nextAnnotations)
    if (!draft || !onSaveDraft) return

    const uiRequest = ++draftSaveUiRequestRef.current
    draftSaveInFlightRef.current = true
    setSavingDraft(true)
    setError('')
    void saveDraftLocally(draft, caption.trim(), nextAnnotations)
      .then(() => {
        if (uiRequest !== draftSaveUiRequestRef.current) return
        setError('')
        setAnnouncement('Your latest memory points are saved on this device.')
      })
      .catch(() => {
        if (uiRequest !== draftSaveUiRequestRef.current) return
        const message = 'Your sphere is still here, but its latest memory points could not be saved. Try saving again.'
        setError(message)
        setAnnouncement(message)
      })
      .finally(() => {
        if (uiRequest === draftSaveUiRequestRef.current) {
          draftSaveInFlightRef.current = false
          setSavingDraft(false)
        }
      })
  }

  /** Leaves review only after the latest queued annotation save has settled. */
  async function finishPanoramaReview() {
    if (onSaveDraft) {
      const uiRequest = ++draftSaveUiRequestRef.current
      draftSaveInFlightRef.current = true
      setSavingDraft(true)
      try {
        await draftSaveQueueRef.current
      } catch {
        const message = 'Save the latest memory points before continuing.'
        setError(message)
        setAnnouncement(message)
        if (uiRequest === draftSaveUiRequestRef.current) {
          draftSaveInFlightRef.current = false
          setSavingDraft(false)
        }
        return
      }
      if (uiRequest === draftSaveUiRequestRef.current) {
        draftSaveInFlightRef.current = false
        setSavingDraft(false)
      }
    }

    setReviewingPanorama(false)
    setAnnouncement(
      annotations.length > 0
        ? `${annotations.length} memory ${annotations.length === 1 ? 'point is' : 'points are'} saved and ready to share.`
        : 'Your 360° review is complete. Add a title, then share it.',
    )
  }

  /** Runs one native capture/composition session or opens the browser concept preview. */
  async function beginGuidedCapture(nextSource: CaptureSource, selectedCapture?: SavedNativeCapture,
    outputWidth: 2048 | 4096 = assemblyMode === 'advanced' ? 4096 : 2048, openFinished = false) {
    // React state disables the button visually; this ref closes the same-tick
    // window before a render so the native bridge can only own one session.
    if (hasBlockingInteraction()) return
    if (nextSource === 'daily' && !canUseDailyWindow && !pendingNativeCaptureRef.current && !selectedCapture) return
    sourceRef.current = nextSource
    setSource(nextSource)
    setShared(false)
    setError('')

    if (!guidedCaptureAvailable) {
      restoreGuideFocusRef.current = false
      setGuidePreview(true)
      setAnnouncement('Opened the guided capture preview.')
      return
    }

    guidedCaptureInFlightRef.current = true
    const requestId = ++guidedCaptureRequestRef.current
    // Async native callbacks are allowed to finish after navigation. Every state
    // mutation below is gated to the mounted request that originally started it.
    const requestIsCurrent = () => (
      mountedRef.current && guidedCaptureRequestRef.current === requestId
    )
    setGuidedCaptureRunning(true)
    setGuidedCaptureStatus('Opening the camera guide…')
    let keepNativeCapture = false
    let attemptedCapture: NativePanoramaCaptureResult | undefined
    try {
      const recovery = captureOwnerKey ? recoverableNativeCaptures.get(captureOwnerKey) : undefined
      if (!selectedCapture && captureOwnerKey && pendingNativeCaptureRef.current && !recovery) {
        pendingNativeCaptureRef.current = null
        setHasPendingCapture(false)
        setAnnouncement('Your previous sphere finished saving in Memories.')
        return
      }
      if (recovery?.saving) {
        setGuidedCaptureStatus('Waiting for your previous save…')
        try { await recovery.saving } catch { /* A failed save remains retryable. */ }
        if (!requestIsCurrent()) return
        if (captureOwnerKey && !recoverableNativeCaptures.has(captureOwnerKey)) {
          pendingNativeCaptureRef.current = null
          setHasPendingCapture(false)
          setAnnouncement('Your previous sphere finished saving in Memories.')
          return
        }
      }
      if (nativeRecovery && !captureOwnerKey) throw new Error('Sign in before capturing so your original photos stay with your account.')
      const result = selectedCapture ?? pendingNativeCaptureRef.current ?? await startGuidedCapture({ ownerKey: captureOwnerKey })
      attemptedCapture = result
      if (nativeRecovery && result.ownerKey !== captureOwnerKey) throw new Error('These original photos are not available for this account.')
      // Originals survive assembly, saving, sharing, cancellation, and navigation.
      keepNativeCapture = true
      retainNativeCapture(result)
      if (!requestIsCurrent()) return
      if (!isCompleteNativeCapture(result)) {
        releaseNativeRecovery(result)
        throw new Error('This capture is incomplete. Its original photos are kept. Start a new capture and finish every dot.')
      }

      setGuidedCaptureStatus('Building your 360° moment…')
      const localProgress = (progress: GuidedPanoramaProgress) => {
        if (!requestIsCurrent()) return
        if (progress.phase === 'reading') {
          setGuidedCaptureStatus(`Reading view ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`)
        } else if (progress.phase === 'projecting') {
          setGuidedCaptureStatus(`Joining view ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`)
        } else {
          setGuidedCaptureStatus('Finishing your 360° moment…')
        }
      }
      let processed: AiProcessedPanorama | undefined
      let qualityNote = `Built from ${result.capturedCount} overlapping views around you.`
      const savedResult = result as SavedNativeCapture
      const resumeNativeJob = nativeRecovery && (savedResult.assembly?.state === 'queued' || savedResult.assembly?.state === 'running')
      if (nativeRecovery && !resumeNativeJob && !openFinished && visibleSavedCaptures.some((capture) =>
        capture.assembly?.state === 'queued' || capture.assembly?.state === 'running')) {
        throw new Error('Another capture is still being assembled on this phone. Resume its progress or stop it before starting another assembly. Your originals are kept.')
      }
      if (nativeRecovery && (advancedNativeAssembly || openFinished || resumeNativeJob)) {
        const controller = new AbortController()
        const detachment = new AbortController()
        aiAbortRef.current = controller
        nativeDetachRef.current = detachment
        setAiAssembling(true)
        const nativeOptions = {
          ownerKey: captureOwnerKey!,
          signal: controller.signal,
          detachSignal: detachment.signal,
          outputWidth,
          onProgress: (progress: NativeStitchProgress) => {
            if (!requestIsCurrent()) return
            setNativeProgress(progress)
            setGuidedCaptureStatus(nativeStitchProgressLabel(progress.stage))
          },
        }
        if (openFinished) {
          setGuidedCaptureStatus('Opening your finished sphere…')
          const detachRead = () => controller.abort()
          detachment.signal.addEventListener('abort', detachRead, { once: true })
          try {
            processed = await openSavedNativePanorama(result, nativeOptions)
          } finally {
            detachment.signal.removeEventListener('abort', detachRead)
          }
        } else {
          processed = await assembleNativePanorama(result, nativeOptions)
        }
        if (requestIsCurrent()) setMemoryRetryCapture(null)
        qualityNote = [processed.report?.aiUsed === true
          ? 'DISK + LightGlue aligned your original photos on this phone.'
          : 'Your original photos were aligned on this phone.',
        'Originals are kept for another try.',
        ...(processed.viewerWidth === 2048 ? ['Assembled at 2048 × 1024 to use less memory.'] : []),
        ...(processed.report?.warnings ?? [])].join(' ')
      } else if (assemblyMode === 'standard') {
        const controller = new AbortController()
        sharedAbortRef.current = controller
        setSharedAssembling(true)
        const compositor = composeGuidedCapture ?? composeGuidedPanorama
        processed = await compositor(result, localProgress, outputWidth, controller.signal)
        if (controller.signal.aborted) throw new DOMException('Assembly stopped. Your originals are kept.', 'AbortError')
        qualityNote = `Blended ${result.capturedCount} original views on this phone. Originals are kept. Review the joins: blending cannot repair camera movement or pose drift in older captures.`
        if (savedResult.assembly?.state === 'failed') qualityNote += ' Advanced alignment previously rejected these photos. This blend does not establish that their alignment is correct.'
      } else {
        const controller = new AbortController()
        aiAbortRef.current = controller
        setGuidedCaptureStatus('Checking enhanced stitching…')
        const health = await checkAiPanoramaHealth({ signal: controller.signal })
        if (!requestIsCurrent()) return
        setAiHealth(health)
        if (health?.aiAvailable) {
          setAiAssembling(true)
          try {
            processed = await assembleAiNativePanorama(result, {
              signal: controller.signal,
              onProgress: (progress) => {
                if (!requestIsCurrent()) return
                setAiProgress(progress)
                setGuidedCaptureStatus(aiPanoramaProgressLabel(progress))
              },
            })
            qualityNote = [processed.report?.aiUsed === true
              ? 'AI aligned the original photos and blended their joins.'
              : 'The original photos were aligned and their joins blended.',
            ...(processed.report?.warnings ?? [])].join(' ')
          } finally {
            if (requestIsCurrent()) { setAiAssembling(false); setAiProgress(null) }
          }
        } else {
          throw new Error('Enhanced stitching is unavailable. Your original photos are kept. Connect the stitching computer, then retry.')
        }
      }
      if (!requestIsCurrent()) return
      if (!processed) throw new Error('Assembly did not return a finished sphere. Your original photos are kept.')
      if (hasLegacyAndroidTracking(result)) qualityNote += ` ${LEGACY_TRACKING_WARNING}`
      if (!requestIsCurrent()) return
      const file = new File(
        [processed.viewer],
        `bubble-${new Date().toISOString().replace(/[:.]/g, '-')}-360.jpg`,
        { type: 'image/jpeg', lastModified: Date.now() },
      )
      const assembledDraft = installDraft(
        file,
        { width: processed.viewerWidth, height: processed.viewerHeight },
        nextSource,
        'guided',
        qualityNote,
        result,
      )
      if (onSaveDraft) {
        setGuidedCaptureStatus('Saving your assembled sphere…')
        try {
          await saveDraftLocally(assembledDraft)
          if (!requestIsCurrent()) return
        } catch {
          if (!requestIsCurrent()) return
          throw new Error('Your sphere was assembled, but it could not be saved yet. The preview and source pictures are still here. Try saving again.')
        }
      }
      setAnnouncement(
        onSaveDraft
          ? 'Your assembled 360° sphere is saved in Memories and ready to review.'
          : 'Your guided 360° moment is ready to review.',
      )
    } catch (captureError) {
      if (requestIsCurrent() && attemptedCapture && isNativePanoramaMemoryFailure(captureError)) setMemoryRetryCapture(attemptedCapture)
      if (requestIsCurrent() && keepNativeCapture) setHasPendingCapture(Boolean(pendingNativeCaptureRef.current))
      if (requestIsCurrent() && (sharedAbortRef.current?.signal.aborted
        || aiAbortRef.current?.signal.aborted || isAiPanoramaCancellation(captureError))) {
        setAnnouncement('Assembly stopped. Your source photos are kept for another try.')
      } else if (requestIsCurrent() && !isNativeCaptureCancellation(captureError)) {
        const message = captureError instanceof Error
          ? captureError.message
          : 'The guided capture could not be completed. Your family has not received anything yet.'
        setError(message)
        setAnnouncement(message)
      }
    } finally {
      if (nativeRecovery && captureOwnerKey && requestIsCurrent()) {
        void getSavedNativeCaptures(captureOwnerKey).then((captures) => {
          if (requestIsCurrent()) setSavedCaptures(captures)
        }).catch(() => undefined)
      }
      if (guidedCaptureRequestRef.current === requestId) {
        guidedCaptureInFlightRef.current = false
        if (mountedRef.current) {
          setGuidedCaptureRunning(false)
          setGuidedCaptureStatus('')
          setAiAssembling(false)
          setSharedAssembling(false)
          setAiProgress(null)
          setNativeProgress(null)
          aiAbortRef.current = null
          nativeDetachRef.current = null
          sharedAbortRef.current = null
        }
      }
    }
  }

  /** Explicitly releases a rejected set so a fresh capture can be started. */
  async function discardPendingSourcePhotos(result: NativePanoramaCaptureResult) {
    if (hasBlockingInteraction()) return
    const recovery = captureOwnerKey ? recoverableNativeCaptures.get(captureOwnerKey) : undefined
    if (recovery?.saving) {
      setError('This sphere is still being saved. Wait for its save to finish before discarding photos.')
      return
    }
    guidedCaptureInFlightRef.current = true
    setGuidedCaptureRunning(true)
    setGuidedCaptureStatus('Discarding the saved source photos…')
    try {
      await discardGuidedCapture(result)
      releaseNativeRecovery(result)
      if (mountedRef.current) {
        setSavedCaptures((captures) => captures.filter((capture) => capture.directoryUrl !== result.directoryUrl))
        setDraft((current) => current && current.nativeCaptureResult?.directoryUrl === result.directoryUrl
          ? { ...current, nativeCaptureResult: undefined } : current)
        setRemoveOriginals(null)
        setError('')
        setAnnouncement('The source photos were discarded. You can start a new capture.')
      }
    } catch {
      if (mountedRef.current) setError('The source photos could not be discarded. Try again.')
    } finally {
      guidedCaptureInFlightRef.current = false
      if (mountedRef.current) {
        setGuidedCaptureRunning(false)
        setGuidedCaptureStatus('')
      }
    }
  }

  /** Lets desktop users assemble original overlapping photos with the same engine. */
  async function selectAiPhotos(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    if (!files.length || hasBlockingInteraction()) return
    const requestId = ++fileSelectionRequestRef.current
    const requestIsCurrent = () => mountedRef.current && fileSelectionRequestRef.current === requestId
    const controller = new AbortController()
    aiAbortRef.current = controller
    fileSelectionInFlightRef.current = true
    setChecking(true)
    setAiAssembling(true)
    setShared(false)
    setError('')
    setGuidedCaptureStatus('Checking enhanced stitching…')
    try {
      const health = await checkAiPanoramaHealth({ signal: controller.signal })
      if (!health?.aiAvailable) throw new Error('The stitching computer is not ready. Start the stitching service, then choose your photos again.')
      const processed = await assembleAiPhotoPanorama(files, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!requestIsCurrent()) return
          setAiProgress(progress)
          setGuidedCaptureStatus(aiPanoramaProgressLabel(progress))
        },
      })
      if (!requestIsCurrent()) return
      const file = new File([processed.viewer], `bubble-ai-${Date.now()}-360.jpg`, { type: 'image/jpeg' })
      const assembled = installDraft(file, {
        width: processed.viewerWidth, height: processed.viewerHeight,
      }, 'manual', 'ai', [
        `Assembled from ${files.length} original photos.`, ...(processed.report?.warnings ?? []),
      ].join(' '))
      if (onSaveDraft) {
        try {
          await saveDraftLocally(assembled)
        } catch {
          if (requestIsCurrent()) setError('Your sphere is ready to review, but could not be saved yet. Try saving again.')
        }
      }
      if (requestIsCurrent()) setAnnouncement('Your assembled sphere is ready to review.')
    } catch (reason) {
      if (!requestIsCurrent()) return
      if (isAiPanoramaCancellation(reason)) {
        setAnnouncement('Assembly stopped. Your original photos are unchanged.')
      } else {
        const message = reason instanceof Error ? reason.message : 'These photos could not be assembled. Try a set with more overlap.'
        setError(message)
        setAnnouncement(message)
      }
    } finally {
      input.value = ''
      if (requestIsCurrent()) {
        fileSelectionInFlightRef.current = false
        aiAbortRef.current = null
        setChecking(false)
        setAiAssembling(false)
        setAiProgress(null)
        setGuidedCaptureStatus('')
      }
    }
  }

  /** Validates and normalizes the latest picker result before installing a draft. */
  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return

    // A newer picker result supersedes earlier async validation/normalization.
    // Only the current request may install or report a draft.
    const requestId = ++fileSelectionRequestRef.current
    const requestIsCurrent = () => (
      mountedRef.current && fileSelectionRequestRef.current === requestId
    )
    fileSelectionInFlightRef.current = true
    clearDraft({ invalidateFileSelection: false })
    const selectedSource = sourceRef.current
    setChecking(true)
    try {
      if (!file.type.startsWith('image/')) {
        setError('Choose an image file from your camera or photo library.')
        setAnnouncement('The selected file is not an image.')
        return
      }

      if (file.size > 25 * 1024 * 1024) {
        const message = 'Choose a 360° panorama smaller than 25 MB.'
        setError(message)
        setAnnouncement(message)
        return
      }

      const dimensions = await readDimensions(file)
      if (!requestIsCurrent()) return
      const validation = validatePanoramaCaptureDimensions(dimensions)

      if (!validation.valid) {
        setError(validation.message)
        setAnnouncement(validation.message)
        return
      }

      let preparedFile = file
      let preparedDimensions = dimensions
      if (validation.needsNormalization) {
        const processed = await processPanorama(file)
        if (!requestIsCurrent()) return
        const filename = file.name.replace(/\.[^.]+$/, '') || 'family-panorama'
        preparedFile = new File(
          [processed.viewer],
          `${filename}-360.jpg`,
          { type: 'image/jpeg', lastModified: file.lastModified },
        )
        preparedDimensions = {
          width: processed.viewerWidth,
          height: processed.viewerHeight,
        }
      }

      const uploadedDraft = installDraft(
        preparedFile,
        preparedDimensions,
        selectedSource,
        'upload',
        validation.warning,
      )
      let savedOnDevice = false
      let saveFailureMessage = ''
      if (onSaveDraft) {
        try {
          await saveDraftLocally(uploadedDraft)
          if (!requestIsCurrent()) return
          savedOnDevice = true
        } catch {
          if (!requestIsCurrent()) return
          saveFailureMessage = 'This panorama is ready to review, but it could not be saved yet. Check free space, then try saving again.'
          setError(saveFailureMessage)
        }
      }
      if (!requestIsCurrent()) return
      setAnnouncement(
        saveFailureMessage || (savedOnDevice
          ? `${file.name} is saved in Memories and ready to review.`
          : validation.needsNormalization
            ? `${file.name} was fitted to a 360-degree frame and is ready to share.`
            : `${file.name} is ready to preview and share.`),
      )
    } catch {
      if (!requestIsCurrent()) return
      const message = 'We could not open this image. Try another 360° panorama.'
      setError(message)
      setAnnouncement(message)
    } finally {
      // Clear this picker even when superseded so choosing the same file later
      // still dispatches change. The captured File object is already owned by
      // its request and does not depend on the live input value.
      input.value = ''
      if (requestIsCurrent()) {
        fileSelectionInFlightRef.current = false
        setChecking(false)
      }
    }
  }

  /** Waits for autosaves, then sends one complete draft through the delivery callback. */
  async function shareCapture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft || shareInFlightRef.current) return

    // Keep editor state stable for the exact draft captured by this request.
    // The ref prevents a second form submit before React paints disabled UI.
    shareInFlightRef.current = true
    captionInputRef.current?.blur()
    setSharing(true)
    setError('')
    try {
      try {
        await draftSaveQueueRef.current
      } catch {
        // Final sharing below writes the complete current draft again, so it
        // safely recovers a failed background annotation autosave.
      }
      await onShare?.({
        id: draft.id,
        file: draft.file,
        caption: caption.trim(),
        source: draft.source,
        width: draft.dimensions.width,
        height: draft.dimensions.height,
        createdAt: draft.createdAt,
        annotations,
      })
      if (draft.nativeCaptureResult && onShare) {
        releaseNativeRecovery(draft.nativeCaptureResult)
        setDraft((currentDraft) =>
          currentDraft?.id === draft.id
            ? {
                ...currentDraft,
                savedLocally: true,
              }
            : currentDraft,
        )
      }
      if (draft.source === 'daily') setCompletedDaily(true)
      setShared(true)
      setAnnouncement(successMessage ?? (onShare
        ? 'Your 360° moment was sent to Memories.'
        : 'Your 360° moment is saved in this local preview.'))
    } catch {
      const message = 'This panorama could not be shared. Your preview is still here, so you can try again.'
      setError(message)
      setAnnouncement(message)
    } finally {
      shareInFlightRef.current = false
      if (mountedRef.current) setSharing(false)
    }
  }

  /** Closes the concept preview while recording where keyboard focus must return. */
  function closeGuidePreview() {
    restoreGuideFocusRef.current = true
    setGuidePreview(false)
  }

  // Restore focus after the preview unmounts rather than while its close button
  // still owns focus in the old tree.
  useEffect(() => {
    if (guidePreview || !restoreGuideFocusRef.current) return
    const frame = window.requestAnimationFrame(() => {
      guidedCaptureButtonRef.current?.focus()
      restoreGuideFocusRef.current = false
    })
    return () => window.cancelAnimationFrame(frame)
  }, [guidePreview])

  if (guidePreview) {
    return <GuidedCapturePreview onClose={closeGuidePreview} />
  }

  return (
    <section
      ref={capturePageRef}
      className={`ks-feature capture-page${draft && !reviewingPanorama && !isSuccess ? ' capture-page--editor' : ''}`}
      aria-labelledby="capture-title"
    >
      <header className="ks-feature__header capture-page__header app-page-header">
        <div className="ks-feature__header-copy">
          <p className="eyebrow app-page-header__eyebrow">Our family</p>
          <h1 id="capture-title">360 Moment</h1>
        </div>
        {onClose ? (
          <button
            className="ks-feature__header-action"
            type="button"
            aria-label="Close 360 capture"
            disabled={interactionBusy && !(nativeRecovery && aiAssembling) && !sharedAssembling}
            onClick={() => {
              if (!hasBlockingInteraction() || (nativeRecovery && aiAssembling) || sharedAssembling) onClose()
            }}
          >
            <CaptureIcon name="close" />
          </button>
        ) : null}
      </header>

      <p className="screen-reader-only" aria-live="polite">{announcement}</p>

      {isSuccess ? (
        <section className="ks-card capture-success" aria-labelledby="capture-success-title">
          <span className="capture-success__icon"><CaptureIcon name="check" /></span>
          <h2 id="capture-success-title">{onShare ? 'Shared with family' : 'Saved to Memories'}</h2>
          <p>{successMessage ?? (onShare
            ? 'Everyone in your circle can find it in Memories.'
            : 'It’s in Memories on this device.')}</p>
          {draft ? <img src={draft.previewUrl} alt="Shared 360 panorama preview" /> : null}
          <div className="capture-success__actions">
            {onViewMemories ? (
              <button
                className="ks-primary-button"
                type="button"
                onClick={onViewMemories}
              >
                View in Memories
              </button>
            ) : null}
            <button className="ks-secondary-button" type="button" onClick={() => {
              clearDraft()
              setShared(false)
              sourceRef.current = 'manual'
              setSource('manual')
            }}>
              Share another
            </button>
          </div>
        </section>
      ) : draft && reviewingPanorama ? (
        <>
          {draft.warning ? <p className="capture-quality-note">{draft.warning}</p> : null}
          {savingDraft ? (
            <p className="capture-quality-note" role="status">
              Saving your latest changes…
            </p>
          ) : draft.savedLocally ? (
            <p className="capture-quality-note" role="status">
              Saved safely to Memories on this device.
            </p>
          ) : null}
          {error ? (
            <div className="capture-draft-save-error">
              <p className="capture-error" role="alert">{error}</p>
              {onSaveDraft ? (
                <button
                  className="ks-secondary-button"
                  type="button"
                  disabled={savingDraft}
                  onClick={() => void retryDraftSave()}
                >
                  {savingDraft ? 'Saving…' : 'Try saving again'}
                </button>
              ) : null}
            </div>
          ) : null}
          <GuidedPanoramaReview
            panoramaUrl={draft.previewUrl}
            annotations={annotations}
            onAnnotationsChange={updateAnnotations}
            onContinue={() => void finishPanoramaReview()}
            onRetake={() => {
              if (hasBlockingInteraction()) return
              const captureSource = draft.source
              const captureOrigin = draft.origin
              const capturePicker = draft.picker ?? 'library'
              clearDraft()
              if (captureOrigin === 'guided') {
                void beginGuidedCapture(captureSource)
              } else if (captureOrigin === 'ai') {
                aiPhotosInputRef.current?.click()
              } else {
                openPicker(captureSource, capturePicker)
              }
            }}
            retakeLabel={draft.origin === 'guided' ? 'Retake' : 'Choose another'}
            busy={interactionBusy}
          />
        </>
      ) : draft ? (
        <CaptureDraftEditor
          previewUrl={draft.previewUrl}
          warning={draft.warning}
          annotationCount={annotations.length}
          caption={caption}
          sharing={sharing}
          error={error}
          connectedFamilySync={connectedFamilySync}
          captionInputRef={captionInputRef}
          onCaptionChange={setCaption}
          onSubmit={shareCapture}
          onRemove={() => {
            if (!hasBlockingInteraction()) clearDraft()
          }}
          onReview={() => setReviewingPanorama(true)}
        />
      ) : (
        <CaptureStartPanel
          source={source}
          nativeRecovery={nativeRecovery}
          hasPendingCapture={hasPendingCapture}
          computerAssembly={computerAssembly}
          enhancedAssemblyAvailable={Boolean(aiHealth?.aiAvailable)}
          assemblyMode={assemblyMode}
          advancedNativeAssembly={advancedNativeAssembly}
          offlineAssemblyAvailable={Boolean(nativeStitchStatus?.available && nativeStitchStatus.offline)}
          nativeProgress={nativeProgress}
          aiProgress={aiProgress}
          sharedAssembling={sharedAssembling}
          aiAssembling={aiAssembling}
          onNewCapture={() => {
            const pending = pendingNativeCaptureRef.current
            if (pending) releaseNativeRecovery(pending)
            void beginGuidedCapture('manual')
          }}
          onChooseAiPhotos={() => aiPhotosInputRef.current?.click()}
          onStopSharedAssembly={() => sharedAbortRef.current?.abort()}
          onStopAiAssembly={() => aiAbortRef.current?.abort()}
          onOpenAiGeneration={onOpenAiGeneration}
          onOpenAdvancedAssembly={onOpenAdvancedAssembly}
          phase={phase}
          captureWindow={captureWindow}
          interactionBusy={interactionBusy}
          guidedCaptureAvailable={guidedCaptureAvailable}
          guidedCaptureRunning={guidedCaptureRunning}
          checking={checking}
          guidedCaptureStatus={guidedCaptureStatus}
          error={error}
          connectedFamilySync={connectedFamilySync}
          guidedCaptureButtonRef={guidedCaptureButtonRef}
          onGuidedCapture={(captureSource) => void beginGuidedCapture(captureSource)}
          onOpenPicker={openPicker}
          onDailyMode={() => {
            if (hasBlockingInteraction()) return
            sourceRef.current = 'daily'
            setSource('daily')
            setError('')
          }}
        />
      )}

      {visibleSavedCaptures.length > 0 ? <details className="capture-originals" open={!draft}>
        <summary>Original photos on this device <span>{visibleSavedCaptures.length} {visibleSavedCaptures.length === 1 ? 'capture' : 'captures'}</span></summary>
        <p>Keep these photos to retry assembly. Saving or sharing a sphere does not remove them.</p>
        {savedCaptureStatusError ? <p role="status">{savedCaptureStatusError}</p> : null}
        <ul>
          {visibleSavedCaptures.map((capture, index) => <li key={capture.directoryUrl ?? index}>
            <div>
              <strong>{isCompleteNativeCapture(capture) ? 'Complete capture' : 'Incomplete capture'}</strong>
              <span>{capture.frames.length} of {capture.targetCount} views{capture.createdAt ? ` · ${new Date(capture.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</span>
              {capture.sessionId && savedCaptureSessions.has(capture.sessionId) ? <p>A sphere from these originals is already saved in Memories. The originals remain available for another try.</p> : null}
              {hasLegacyAndroidTracking(capture) ? <p>{LEGACY_TRACKING_WARNING}</p> : null}
              {assemblyMode === 'standard' && capture.assembly?.state === 'failed' ? <p>Advanced alignment previously rejected these photos. Rebuilding with the shared blend may still produce misaligned views; it does not repair their tracking. Rebuild only if you want to inspect another result.</p> : null}
              {!isCompleteNativeCapture(capture) ? <p>These originals are kept, but do not cover a complete sphere. Start a new capture to finish every direction.</p> : null}
              {capture.assembly?.state === 'queued' || capture.assembly?.state === 'running' ? <p>
                {nativeStitchProgressLabel(capture.assembly.stage ?? 'queued')} · {Math.round(Math.max(0, Math.min(1, capture.assembly.progress ?? 0)) * 100)}%
              </p> : null}
              {capture.assembly?.state === 'failed' && capture.assembly.error ? <p>{capture.assembly.error}</p> : null}
              {capture.savedResult?.state === 'completed' && capture.savedResult.report ? <p>
                {capture.savedResult.report.aiUsed === true ? 'Saved result aligned on this phone with DISK + LightGlue.' : 'Saved result assembled on this phone.'}
                {' '}{capture.savedResult.report.warnings?.join(' ')}
              </p> : capture.assembly?.state === 'completed' && capture.assembly.report ? <p>
                {capture.assembly.report.aiUsed === true ? 'Aligned on this phone with DISK + LightGlue.' : 'Assembled on this phone.'}
                {' '}{capture.assembly.report.warnings?.join(' ')}
              </p> : null}
            </div>
            {nativeRecovery && (capture.savedResult?.state === 'completed' || capture.assembly?.state === 'completed') ? <button className="ks-secondary-button" type="button" disabled={interactionBusy} onClick={() => {
              clearDraft()
              setShared(false)
              void beginGuidedCapture(source, capture, 4096, true)
            }}>Open finished sphere</button> : null}
            {isCompleteNativeCapture(capture) ? <button className="ks-secondary-button" type="button" disabled={interactionBusy} onClick={() => {
              clearDraft()
              setShared(false)
              void beginGuidedCapture(source, capture)
            }}>{nativeRecovery
                ? capture.assembly?.state === 'running' || capture.assembly?.state === 'queued' ? 'Resume progress' : 'Retry on this phone'
                : assemblyMode === 'standard' ? 'Retry on this phone' : 'Retry enhanced assembly'}</button> : null}
            {advancedNativeAssembly && isCompleteNativeCapture(capture)
              && (isNativePanoramaMemoryFailure(capture.assembly) || memoryRetryCapture?.directoryUrl === capture.directoryUrl) ? <>
                <p>This phone ran short of memory. A smaller 2048 × 1024 sphere uses less memory and keeps your original photos.</p>
                <button className="ks-secondary-button" type="button" disabled={interactionBusy} onClick={() => {
                  clearDraft()
                  setShared(false)
                  void beginGuidedCapture(source, capture, 2048)
                }}>Retry with less memory</button>
              </> : null}
            <button className="capture-originals__remove" type="button" disabled={interactionBusy || capture.assembly?.state === 'queued' || capture.assembly?.state === 'running'} onClick={() => {
              setAcknowledgedAssemblyRemoval(false)
              setRemoveOriginals(capture)
            }}>Remove originals</button>
          </li>)}
        </ul>
      </details> : null}

      {removeOriginals ? <section className="capture-originals-confirm" role="region" aria-labelledby="remove-originals-title">
        <h2 id="remove-originals-title">Remove these original photos?</h2>
        <p>This permanently removes {removeOriginals.frames.length} captured photos and this capture’s local assembly files. Any sphere already saved in Memories is kept. These photos will no longer be available to rebuild it.</p>
        {needsAssemblyRemovalAcknowledgement ? <label>
          <input type="checkbox" checked={acknowledgedAssemblyRemoval} disabled={interactionBusy} onChange={(event) => setAcknowledgedAssemblyRemoval(event.target.checked)} />
          I understand the local finished sphere is also removed, including if I have not saved it to Memories.
        </label> : null}
        <div>
          <button className="ks-secondary-button" type="button" disabled={interactionBusy} onClick={() => setRemoveOriginals(null)}>Keep originals</button>
          <button className="ks-secondary-button capture-originals__remove" type="button" disabled={interactionBusy || (needsAssemblyRemovalAcknowledgement && !acknowledgedAssemblyRemoval)} onClick={() => void discardPendingSourcePhotos(removeOriginals)}>Permanently remove originals</button>
        </div>
      </section> : null}

      {computerAssembly ? <input
        ref={aiPhotosInputRef}
        className="capture-file-input"
        type="file"
        accept="image/jpeg"
        multiple
        aria-label="Choose overlapping source photos for AI assembly"
        tabIndex={-1}
        disabled={interactionBusy}
        onChange={(event) => void selectAiPhotos(event)}
      /> : null}
      <input
        ref={cameraInputRef}
        className="capture-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take a panorama with camera"
        tabIndex={-1}
        disabled={interactionBusy}
        onChange={(event) => void selectFile(event)}
      />
      <input
        ref={libraryInputRef}
        className="capture-file-input"
        type="file"
        accept="image/*"
        aria-label="Choose a 360 photo from camera or library"
        tabIndex={-1}
        disabled={interactionBusy}
        onChange={(event) => void selectFile(event)}
      />
    </section>
  )
}
