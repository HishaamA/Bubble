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
import {
  composeGuidedPanorama,
  type GuidedPanoramaProgress,
} from '../../services/media/composeGuidedPanorama'
import { GuidedCapturePreview } from './GuidedCapturePreview'
import { GuidedPanoramaReview } from './GuidedPanoramaReview'
import {
  discardNativePanoramaCapture,
  isNativeCaptureCancellation,
  isNativePanoramaCaptureAvailable,
  startNativePanoramaCapture,
  type NativePanoramaCaptureResult,
} from './nativePanoramaCapture'
import { installCaptureEditorViewportSync } from './captureEditorViewport'
import { CaptureDraftEditor } from './CaptureDraftEditor'
import { CaptureStartPanel } from './CaptureStartPanel'
import { CaptureIcon } from './CaptureIcon'

import type { CaptureSource, Capture360Submission } from './captureTypes'
export type { CaptureSource, Capture360Submission } from './captureTypes'

type Capture360PageProps = {
  now?: Date
  dailyWindow?: DailyCaptureWindow
  familySeed?: string
  dailyCaptureCompleted?: boolean
  initialMode?: CaptureSource
  connectedFamilySync?: boolean
  onClose?: () => void
  onViewMemories?: () => void
  onSaveDraft?: (submission: Capture360Submission) => void | Promise<void>
  onShare?: (submission: Capture360Submission) => void | Promise<void>
  readDimensions?: (file: File) => Promise<ImageDimensions>
  processPanorama?: (file: File) => Promise<ProcessedPanorama>
  guidedCaptureAvailable?: boolean
  startGuidedCapture?: () => Promise<NativePanoramaCaptureResult>
  discardGuidedCapture?: (result: NativePanoramaCaptureResult) => Promise<void>
  composeGuidedCapture?: (
    result: NativePanoramaCaptureResult,
    onProgress?: (progress: GuidedPanoramaProgress) => void,
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
  origin: 'guided' | 'upload'
  savedLocally: boolean
  nativeCaptureResult?: NativePanoramaCaptureResult
  picker?: 'camera' | 'library'
  warning?: string
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
  dailyCaptureCompleted = false,
  initialMode = 'daily',
  connectedFamilySync = false,
  onClose,
  onViewMemories,
  onSaveDraft,
  onShare,
  readDimensions = readImageDimensions,
  processPanorama = processPanoramaForSharing,
  guidedCaptureAvailable = isNativePanoramaCaptureAvailable(),
  startGuidedCapture = startNativePanoramaCapture,
  discardGuidedCapture = discardNativePanoramaCapture,
  composeGuidedCapture = composeGuidedPanorama,
  successMessage,
}: Capture360PageProps) {
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
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
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
  }, [])

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
  const interactionBusy = checking || guidedCaptureRunning || savingDraft || sharing

  /** Reads synchronous mutexes that close React's pre-render double-action window. */
  function hasBlockingInteraction() {
    return (
      guidedCaptureInFlightRef.current ||
      fileSelectionInFlightRef.current ||
      draftSaveInFlightRef.current ||
      shareInFlightRef.current
    )
  }

  /** Releases one draft's browser/native resources and resets its editor state. */
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
    if (nativeCaptureResult) {
      void discardGuidedCapture(nativeCaptureResult).catch(() => undefined)
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

    try {
      await saveOperation
      if (selectedDraft.nativeCaptureResult) {
        try {
          await discardGuidedCapture(selectedDraft.nativeCaptureResult)
        } catch {
          // The assembled panorama is durable now. Stale cache cleanup can be
          // retried by the OS without putting the saved moment at risk.
        }
      }
      setDraft((currentDraft) =>
        currentDraft?.id === selectedDraft.id
          ? {
              ...currentDraft,
              savedLocally:
                saveVersion === draftSaveVersionRef.current
                  ? true
                  : currentDraft.savedLocally,
              nativeCaptureResult: undefined,
            }
          : currentDraft,
      )
    } catch (reason) {
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
  async function beginGuidedCapture(nextSource: CaptureSource) {
    // React state disables the button visually; this ref closes the same-tick
    // window before a render so the native bridge can only own one session.
    if (hasBlockingInteraction()) return
    if (nextSource === 'daily' && !canUseDailyWindow) return
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
    let captureResult: NativePanoramaCaptureResult | undefined
    let keepNativeCapture = false
    try {
      const result = await startGuidedCapture()
      captureResult = result
      if (!requestIsCurrent()) return
      if (
        result.frames.length < result.targetCount ||
        result.capturedCount < result.targetCount
      ) {
        throw new Error('Capture every surrounding dot before finishing.')
      }

      setGuidedCaptureStatus('Building your 360° moment…')
      const processed = await composeGuidedCapture(result, (progress) => {
        if (!requestIsCurrent()) return
        if (progress.phase === 'reading') {
          setGuidedCaptureStatus(`Reading view ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`)
        } else if (progress.phase === 'projecting') {
          setGuidedCaptureStatus(`Joining view ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}…`)
        } else {
          setGuidedCaptureStatus('Finishing your 360° moment…')
        }
      })
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
        `Built from ${result.capturedCount} overlapping views around you.`,
        result,
      )
      if (onSaveDraft) {
        setGuidedCaptureStatus('Saving your assembled sphere…')
        try {
          await saveDraftLocally(assembledDraft)
          // saveDraftLocally has made the panorama durable and released the
          // native frame directory, so the bridge result is no longer ours.
          captureResult = undefined
          if (!requestIsCurrent()) return
        } catch {
          if (!requestIsCurrent()) return
          keepNativeCapture = true
          throw new Error('Your sphere was assembled, but it could not be saved yet. The preview and source pictures are still here. Try saving again.')
        }
      }
      setAnnouncement(
        onSaveDraft
          ? 'Your assembled 360° sphere is saved in Memories and ready to review.'
          : 'Your guided 360° moment is ready to review.',
      )
    } catch (captureError) {
      if (requestIsCurrent() && !isNativeCaptureCancellation(captureError)) {
        const message = captureError instanceof Error
          ? captureError.message
          : 'The guided capture could not be completed. Your family has not received anything yet.'
        setError(message)
        setAnnouncement(message)
      }
    } finally {
      if (captureResult && !keepNativeCapture) {
        try {
          await discardGuidedCapture(captureResult)
        } catch {
          // Cache directories are OS-evictable; cleanup failure must not throw
          // away the finished, already-sanitized panorama.
        }
      }
      if (guidedCaptureRequestRef.current === requestId) {
        guidedCaptureInFlightRef.current = false
        if (mountedRef.current) {
          setGuidedCaptureRunning(false)
          setGuidedCaptureStatus('')
        }
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
      if (draft.nativeCaptureResult) {
        try {
          await discardGuidedCapture(draft.nativeCaptureResult)
        } catch {
          // Sharing already made the assembled panorama durable.
        }
        setDraft((currentDraft) =>
          currentDraft?.id === draft.id
            ? {
                ...currentDraft,
                savedLocally: true,
                nativeCaptureResult: undefined,
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
            disabled={interactionBusy}
            onClick={() => {
              if (!hasBlockingInteraction()) onClose()
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
              } else {
                openPicker(captureSource, capturePicker)
              }
            }}
            retakeLabel={draft.origin === 'upload' ? 'Choose another' : 'Retake'}
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
