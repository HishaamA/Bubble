import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import {
  addFamilyMomentComment,
  fetchFamilyMomentComments,
  subscribeToFamilyMomentComments,
  type FamilyMomentComment,
} from '../../services/media/familyMomentCommentService'
import { GuidedPanoramaReview } from '../capture/GuidedPanoramaReview'
import { PanoramaViewer, type PanoramaScene } from '../../viewer'
import { FamilyCommentsPanel } from './FamilyCommentsPanel'
import {
  CardboardSetupFlow,
  CardboardViewer,
  type CardboardMemoryChoice,
  type CardboardEntryOptions,
  type CardboardViewerHandle,
} from './cardboard'
import { presentNativeCardboardPanorama } from './cardboard/nativeCardboardPanorama'
import { memories } from './memories'
import type {
  PanoramaAnnotation,
  PanoramaMoment,
  StoredPanoramaAnnotation,
} from './shared'

const DEMO_VOICE_NOTE =
  'Sunday dinner always sounds like this: everyone talking, everyone laughing, and nobody ready to leave.'
function CommentsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 5.5h13A2.5 2.5 0 0 1 21 8v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3v-3h-1A2.5 2.5 0 0 1 3 15V8a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M7.5 10h9M7.5 13h6" />
    </svg>
  )
}

function MemoryPointIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function annotationDescription(annotation: PanoramaAnnotation) {
  const message = annotation.message.trim()
  if (message) return message
  return annotation.kind === 'voice'
    ? 'A voice note from this moment'
    : 'A note from this moment'
}

function annotationHotSpotLabel(annotation: PanoramaAnnotation) {
  const description = annotationDescription(annotation)
  if (annotation.kind === 'voice') {
    return annotation.audioUrl
      ? `Play voice note: ${description}`
      : `Voice note unavailable: ${description}`
  }
  return `Read note: ${description}`
}

function isSameLocalDay(value: string, reference: Date): boolean {
  const date = new Date(value)
  return (
    Number.isFinite(date.getTime()) &&
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  )
}

type PanoramaMemoryScreenProps = {
  sharedMoments?: PanoramaMoment[]
  sharedMomentsLoading?: boolean
  onUpdateMomentAnnotations?: (
    moment: PanoramaMoment,
    annotations: StoredPanoramaAnnotation[],
  ) => Promise<void>
}

export function PanoramaMemoryScreen({
  sharedMoments = [],
  sharedMomentsLoading = false,
  onUpdateMomentAnnotations,
}: PanoramaMemoryScreenProps = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { memoryId = 'dinner' } = useParams()
  const routeState = location.state as {
    returnTo?: string
    openVr?: boolean
    journalContext?: {
      selectedDayKey?: string
      view?: 'grid' | 'list'
      scrollTop?: number
      focusMemoryId?: string
    }
  } | null
  const requestedReturnTo = routeState?.returnTo
  const requestedOpenVr = routeState?.openVr === true
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null)
  const [activeAnnotation, setActiveAnnotation] =
    useState<PanoramaAnnotation | null>(null)
  const [cardboardActive, setCardboardActive] = useState(false)
  const [vrEntering, setVrEntering] = useState(false)
  const [vrError, setVrError] = useState<string | null>(null)
  const [vrSetupOpen, setVrSetupOpen] = useState(requestedOpenVr)
  const [selectedVrMemoryId, setSelectedVrMemoryId] = useState(memoryId)
  const [comments, setComments] = useState<FamilyMomentComment[]>([])
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsSending, setCommentsSending] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentTargetAnnotationId, setCommentTargetAnnotationId] = useState<
    string | null
  >(null)
  const [pointEditorOpen, setPointEditorOpen] = useState(false)
  const [pointDraft, setPointDraft] = useState<StoredPanoramaAnnotation[]>([])
  const [pointEditorSaving, setPointEditorSaving] = useState(false)
  const [pointEditorError, setPointEditorError] = useState<string | null>(null)
  const [pointEditorSaved, setPointEditorSaved] = useState(false)
  const pointSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pointSaveRevisionRef = useRef(0)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const vrButtonRef = useRef<HTMLButtonElement>(null)
  const commentsButtonRef = useRef<HTMLButtonElement>(null)
  const cardboardRef = useRef<CardboardViewerHandle>(null)
  const sharedMomentId = memoryId.startsWith('shared-')
    ? memoryId.slice('shared-'.length)
    : null
  const sharedMoment = sharedMomentId
    ? sharedMoments.find(({ id }) => id === sharedMomentId)
    : undefined
  const staticMemory = memories.find(({ id }) => id === memoryId)
  const memory = sharedMoment
    ? {
        id: `shared-${sharedMoment.id}`,
        label: sharedMoment.label,
        date: new Intl.DateTimeFormat('en', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }).format(new Date(sharedMoment.createdAt)),
      }
    : staticMemory ?? memories[0]
  const returnTo = requestedReturnTo === '/journal' ? '/journal' : '/'
  const returnLabel =
    returnTo === '/journal' ? 'Back to journal' : 'Back to memories'
  const sharedMemoryMissing = Boolean(sharedMomentId && !sharedMoment)
  const canEditMemoryPoints = Boolean(
    sharedMoment?.ownedByCurrentUser === true &&
    sharedMoment.objectUrl &&
    onUpdateMomentAnnotations,
  )

  const openPointEditor = useCallback(() => {
    if (!sharedMoment || !canEditMemoryPoints) return
    setCommentsOpen(false)
    setActiveAnnotation(null)
    setPointEditorError(null)
    setPointEditorSaved(false)
    pointSaveRevisionRef.current += 1
    setPointDraft(
      (sharedMoment.annotations ?? []).map(
        ({ audioUrl: _audioUrl, ...annotation }) => ({ ...annotation }),
      ),
    )
    setPointEditorOpen(true)
  }, [canEditMemoryPoints, sharedMoment])

  const savePointDraft = useCallback((next: StoredPanoramaAnnotation[]) => {
    if (
      !sharedMoment ||
      !canEditMemoryPoints ||
      !onUpdateMomentAnnotations
    ) {
      return
    }

    setPointDraft(next)
    setPointEditorSaved(false)
    setPointEditorSaving(true)
    setPointEditorError(null)
    const revision = pointSaveRevisionRef.current + 1
    pointSaveRevisionRef.current = revision
    const save = pointSaveQueueRef.current
      .catch(() => undefined)
      .then(() => onUpdateMomentAnnotations(sharedMoment, next))
    pointSaveQueueRef.current = save

    void save.then(() => {
      if (pointSaveRevisionRef.current !== revision) return
      setPointEditorSaving(false)
      setPointEditorError(null)
      setPointEditorSaved(true)
    }).catch((reason) => {
      if (pointSaveRevisionRef.current !== revision) return
      setPointEditorSaving(false)
      setPointEditorSaved(false)
      setPointEditorError(
        reason instanceof Error
          ? reason.message
          : 'Your memory points could not be saved. Please try again.',
      )
    })
  }, [
    canEditMemoryPoints,
    onUpdateMomentAnnotations,
    sharedMoment,
  ])

  const closePointEditor = useCallback(() => {
    if (pointEditorSaving || pointEditorError) return
    setPointEditorOpen(false)
    setPointEditorSaved(false)
  }, [pointEditorError, pointEditorSaving])

  const discardPointEditor = useCallback(() => {
    if (pointEditorSaving) return
    pointSaveRevisionRef.current += 1
    setPointEditorOpen(false)
    setPointEditorError(null)
    setPointEditorSaved(false)
  }, [pointEditorSaving])

  useEffect(() => {
    if (!pointEditorOpen) return

    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || pointEditorSaving || pointEditorError) return
      event.preventDefault()
      closePointEditor()
    }
    window.addEventListener('keydown', closeFromKeyboard)

    let active = true
    let backListener: { remove: () => Promise<void> } | undefined
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('backButton', () => {
        if (!pointEditorSaving && !pointEditorError) closePointEditor()
      }).then((listener) => {
        if (!active) {
          void listener.remove()
          return
        }
        backListener = listener
      })
    }

    return () => {
      active = false
      window.removeEventListener('keydown', closeFromKeyboard)
      void backListener?.remove()
    }
  }, [closePointEditor, pointEditorError, pointEditorOpen, pointEditorSaving])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined

    queueMicrotask(() => {
      if (!active) return
      setComments([])
      setCommentsOpen(false)
      setCommentTargetAnnotationId(null)
      setCommentsError(null)
      if (!sharedMomentId) setCommentsLoading(false)
    })
    if (!sharedMomentId) {
      return () => undefined
    }

    const refresh = async (announceLoading = false) => {
      if (announceLoading && active) setCommentsLoading(true)
      try {
        const next = await fetchFamilyMomentComments(sharedMomentId)
        if (!active) return
        setComments(next)
        setCommentsError(null)
      } catch {
        if (active) {
          setCommentsError('The family conversation could not be loaded. Try again in a moment.')
        }
      } finally {
        if (active && announceLoading) setCommentsLoading(false)
      }
    }

    void subscribeToFamilyMomentComments(sharedMomentId, () => {
      void refresh(false)
    }).then((cleanup) => {
      if (!active) {
        cleanup()
        return
      }
      unsubscribe = cleanup
    }).catch(() => {
      if (active) {
        setCommentsError('Live family comments are temporarily unavailable.')
      }
    })
    void refresh(true)

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [sharedMomentId])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!vrSetupOpen) {
        titleRef.current?.focus({ preventScroll: true })
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [memory.id, vrSetupOpen])

  useEffect(
    () => () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    },
    [],
  )

  const stopVoiceNote = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setVoiceMessage(null)
  }, [])

  const openAnnotation = useCallback((annotation: PanoramaAnnotation) => {
    setActiveAnnotation(annotation)
  }, [])

  const closeComments = useCallback(() => {
    setCommentsOpen(false)
    setCommentsError(null)
    window.requestAnimationFrame(() => {
      commentsButtonRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const openComments = useCallback((annotationId: string | null = null) => {
    setCommentTargetAnnotationId(annotationId)
    setCommentsError(null)
    setCommentsOpen(true)
  }, [])

  const submitComment = useCallback(async (
    body: string,
    annotationId: string | null,
  ) => {
    if (!sharedMomentId || commentsSending) return
    setCommentsSending(true)
    setCommentsError(null)
    try {
      const saved = await addFamilyMomentComment({
        momentId: sharedMomentId,
        annotationId,
        body,
        authorDisplayName: 'You',
      })
      setComments((current) => {
        const byId = new Map(current.map((comment) => [comment.id, comment]))
        byId.set(saved.id, saved)
        return [...byId.values()].sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
        )
      })
    } catch (reason) {
      setCommentsError(
        reason instanceof Error
          ? reason.message
          : 'Your comment could not be shared. Please try again.',
      )
      throw reason
    } finally {
      setCommentsSending(false)
    }
  }, [commentsSending, sharedMomentId])

  const returnToMemories = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    navigate(returnTo, {
      state:
        returnTo === '/journal'
          ? { journalContext: routeState?.journalContext }
          : { restoreMemoryId: memory.id },
      viewTransition: true,
    })
  }, [memory.id, navigate, returnTo, routeState?.journalContext])

  const returnFromVrToOrigin = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    navigate(returnTo, {
      replace: true,
      state:
        returnTo === '/journal'
          ? { journalContext: routeState?.journalContext }
          : { restoreMemoryId: selectedVrMemoryId },
    })
  }, [navigate, returnTo, routeState?.journalContext, selectedVrMemoryId])

  const playVoiceNote = useCallback(() => {
    setVoiceMessage(DEMO_VOICE_NOTE)
    if (!('speechSynthesis' in window)) return

    window.speechSynthesis.cancel()
    const note = new SpeechSynthesisUtterance(DEMO_VOICE_NOTE)
    note.rate = 0.92
    note.pitch = 1.02
    window.speechSynthesis.speak(note)
  }, [])

  const openVrSetup = useCallback(() => {
    setSelectedVrMemoryId(memory.id)
    setVrError(null)
    setCommentsOpen(false)
    setVrSetupOpen(true)
  }, [memory.id])

  const vrChoices = useMemo<CardboardMemoryChoice[]>(
    () => {
      const today = new Date()
      return [
        ...sharedMoments
          .filter(
            (moment): moment is PanoramaMoment & { objectUrl: string } =>
              Boolean(moment.objectUrl) &&
              (isSameLocalDay(moment.createdAt, today) ||
                moment.id === sharedMomentId),
          )
          .map((moment) => ({
            id: `shared-${moment.id}`,
            label: moment.label,
            sender: moment.uploaderDisplayName,
            thumbnailUrl: moment.objectUrl,
          })),
        ...memories.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          sender: candidate.sender,
          thumbnailUrl: candidate.thumbnail,
        })),
      ]
    },
    [sharedMomentId, sharedMoments],
  )

  const selectedVrChoice =
    vrChoices.find(({ id }) => id === selectedVrMemoryId) ??
    vrChoices.find(({ id }) => id === memory.id) ??
    vrChoices[0]
  const selectedVrSharedId = selectedVrChoice?.id.startsWith('shared-')
    ? selectedVrChoice.id.slice('shared-'.length)
    : null
  const selectedVrSharedMoment = selectedVrSharedId
    ? sharedMoments.find(({ id }) => id === selectedVrSharedId)
    : undefined
  const selectedVrStaticMemory = selectedVrChoice
    ? memories.find(({ id }) => id === selectedVrChoice.id)
    : undefined

  const cardboardScenes = useMemo<PanoramaScene[]>(() => {
    if (selectedVrSharedMoment?.objectUrl) {
      return [
        {
          id: `cardboard-shared-${selectedVrSharedMoment.id}`,
          panorama: selectedVrSharedMoment.objectUrl,
          alt: `${selectedVrSharedMoment.label}, a family 360 panorama shared by ${selectedVrSharedMoment.uploaderDisplayName}.`,
          title: selectedVrSharedMoment.label,
          description:
            selectedVrSharedMoment.caption ||
            `Shared by ${selectedVrSharedMoment.uploaderDisplayName} with the family.`,
          hotSpots: (selectedVrSharedMoment.annotations ?? []).map((annotation) => ({
            id: annotation.id,
            kind: annotation.kind === 'voice' ? 'audio' : 'info',
            pitch: annotation.pitch,
            yaw: annotation.yaw,
            label: annotationHotSpotLabel(annotation),
            onActivate: () => openAnnotation(annotation),
          })),
          pitch: 0,
          yaw: 0,
          hfov: 104,
          minHfov: 52,
          maxHfov: 120,
        },
      ]
    }

    const selectedMemory = selectedVrStaticMemory ?? memories[0]
    return [
      {
        id: `cardboard-${selectedMemory.id}`,
        panorama: '/assets/panoramas/sunday-dinner-demo.jpg',
        alt: 'A warm panoramic family dinner around a candlelit table.',
        title: selectedMemory.label,
        description: `A family moment shared by ${selectedMemory.sender}.`,
        pitch: -2,
        yaw: 12,
        hfov: 104,
        minHfov: 52,
        maxHfov: 120,
      },
    ]
  }, [openAnnotation, selectedVrSharedMoment, selectedVrStaticMemory])

  const enterCardboard = useCallback(async (options?: CardboardEntryOptions) => {
    if (vrEntering || cardboardActive) return

    setVrEntering(true)
    setCommentsOpen(false)
    setVrError(null)
    try {
      const nativeScene = cardboardScenes[0]
      const nativeOpened = nativeScene
          ? await presentNativeCardboardPanorama({
              scene: nativeScene,
              sourceBlob: selectedVrSharedMoment?.blob,
              onClosed: returnFromVrToOrigin,
            })
        : false

      if (!nativeOpened) {
        await cardboardRef.current?.enter(options)
      }
      // A direct VR route intentionally hides the regular panorama screen. Keep
      // its setup sheet mounted behind the native Activity so there is a usable
      // destination when the headset close button returns to the WebView.
      if (!nativeOpened || !requestedOpenVr) {
        setVrSetupOpen(false)
      }
    } catch {
      setVrError(
        'Cardboard view could not start. The panorama is still available to drag.',
      )
    } finally {
      setVrEntering(false)
    }
  }, [
    cardboardActive,
    cardboardScenes,
    requestedOpenVr,
    returnFromVrToOrigin,
    selectedVrSharedMoment,
    vrEntering,
  ])

  const scenes = useMemo<PanoramaScene[]>(
    () => {
      if (sharedMoment?.objectUrl) {
        return [
          {
            id: `shared-scene-${sharedMoment.id}`,
            panorama: sharedMoment.objectUrl,
            alt: `${sharedMoment.label}, a family 360 panorama shared by ${sharedMoment.uploaderDisplayName}.`,
            title: sharedMoment.label,
            description:
              sharedMoment.caption ||
              `Shared by ${sharedMoment.uploaderDisplayName} with the family.`,
            hotSpots: (sharedMoment.annotations ?? []).map((annotation) => ({
              id: annotation.id,
              kind: annotation.kind === 'voice' ? 'audio' : 'info',
              pitch: annotation.pitch,
              yaw: annotation.yaw,
              label: annotationHotSpotLabel(annotation),
              onActivate: () => openAnnotation(annotation),
            })),
            pitch: 0,
            yaw: 0,
            hfov: 104,
            minHfov: 52,
            maxHfov: 120,
          },
        ]
      }

      return [
        {
        id: 'sunday-dinner',
        panorama: '/assets/panoramas/sunday-dinner-demo.jpg',
        alt: 'A warm panoramic family dinner around a candlelit table.',
        title: memory.label,
        description: 'A bundled concept panorama for the first Bubble memory flow.',
        pitch: -2,
        yaw: 12,
        hfov: 104,
        minHfov: 52,
        maxHfov: 120,
        hotSpots: [
          {
            id: 'chair-note',
            kind: 'audio',
            pitch: -18,
            yaw: -24,
            label: 'Play the chair voice note',
            onActivate: playVoiceNote,
          },
        ],
        },
      ]
    },
    [memory.label, openAnnotation, playVoiceNote, sharedMoment],
  )

  const initialSceneId = scenes[0]?.id

  const transitionStyle = requestedOpenVr
    ? undefined
    : ({
        viewTransitionName: `memory-${memory.id}`,
      } as CSSProperties)
  const activeAnnotationDescription = activeAnnotation
    ? annotationDescription(activeAnnotation)
    : ''

  if (sharedMemoryMissing && sharedMomentsLoading) {
    return (
      <section className="fatal-state" aria-live="polite">
        <p className="eyebrow">Family memory</p>
        <h1>Opening the shared 360…</h1>
      </section>
    )
  }

  if (sharedMemoryMissing || !initialSceneId) {
    return (
      <section className="fatal-state">
        <p className="eyebrow">Memory unavailable</p>
        <h1>This shared 360 is not on this device.</h1>
        <p>
          {returnTo === '/journal'
            ? 'Return to Journal and choose another family moment.'
            : 'Return to Memories and choose another family moment.'}
        </p>
        <button type="button" onClick={returnToMemories}>
          {returnLabel}
        </button>
      </section>
    )
  }

  return (
    <section className="panorama-screen" aria-labelledby="panorama-memory-title">
      <div className="panorama-transition-surface" style={transitionStyle}>
        {!cardboardActive && !requestedOpenVr && !pointEditorOpen ? (
          <PanoramaViewer
            scenes={scenes}
            initialSceneId={initialSceneId}
            ariaLabel={`${memory.label} panoramic memory`}
            additionalControls={sharedMoment ? (
              <>
                <button
                  ref={commentsButtonRef}
                  type="button"
                  className={commentsOpen ? 'is-active ks-panorama__comments-button' : 'ks-panorama__comments-button'}
                  onClick={() => openComments(null)}
                  aria-label={`Open family comments, ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`}
                  aria-expanded={commentsOpen}
                  aria-controls="family-comments-panel"
                >
                  <CommentsIcon />
                  {comments.length > 0 ? (
                    <span className="ks-panorama__comment-count" aria-hidden="true">
                      {comments.length > 99 ? '99+' : comments.length}
                    </span>
                  ) : null}
                </button>
              </>
            ) : undefined}
          />
        ) : null}
      </div>

      <CardboardViewer
        ref={cardboardRef}
        scenes={cardboardScenes}
        initialSceneId={cardboardScenes[0]?.id}
        ariaLabel={`${selectedVrChoice?.label ?? memory.label} Cardboard panoramic memory`}
        memoryByline={selectedVrChoice?.sender}
        onActiveChange={(active) => {
          setCardboardActive(active)
          if (active) {
            setVrSetupOpen(false)
            setCommentsOpen(false)
          }
        }}
        onExit={returnFromVrToOrigin}
      />

      <CardboardSetupFlow
        open={vrSetupOpen && !cardboardActive}
        choices={vrChoices}
        selectedMemoryId={selectedVrChoice?.id ?? ''}
        allowMemorySelection={requestedOpenVr}
        busy={vrEntering}
        error={vrError}
        onSelectMemory={(memoryId) => {
          setSelectedVrMemoryId(memoryId)
          setVrError(null)
        }}
        onGo={(options) => void enterCardboard(options)}
        onClose={() => {
          if (vrEntering) return
          if (requestedOpenVr) {
            returnFromVrToOrigin()
            return
          }
          setVrSetupOpen(false)
          setVrError(null)
          window.requestAnimationFrame(() => {
            vrButtonRef.current?.focus({ preventScroll: true })
          })
        }}
      />

      {canEditMemoryPoints && !requestedOpenVr && !cardboardActive && !pointEditorOpen ? (
        <button
          type="button"
          className="panorama-memory-points-cta"
          onClick={openPointEditor}
        >
          <MemoryPointIcon />
          <span>
            {(sharedMoment?.annotations?.length ?? 0) > 0
              ? `Edit ${sharedMoment?.annotations?.length} memory ${sharedMoment?.annotations?.length === 1 ? 'point' : 'points'}`
              : 'Add memory point'}
          </span>
        </button>
      ) : null}

      {!requestedOpenVr && !pointEditorOpen ? (
        <header className="panorama-top-bar">
          <button type="button" onClick={returnToMemories} aria-label={returnLabel}>
            <Icon name="arrow" size={24} />
          </button>
          <div>
            <p className="eyebrow">{memory.date}</p>
            <h1 id="panorama-memory-title" ref={titleRef} tabIndex={-1}>
              {memory.label}
            </h1>
          </div>
          <button
            ref={vrButtonRef}
            className="panorama-vr-button"
            type="button"
            onClick={openVrSetup}
            aria-label="Set up Cardboard VR view"
            disabled={cardboardActive}
          >
            <Icon name="vr" size={25} />
          </button>
        </header>
      ) : null}

      <p className="screen-reader-only" role="status" aria-live="polite">
        {requestedOpenVr
          ? 'Cardboard setup opened.'
          : `${memory.label} panoramic memory opened.`}
      </p>

      {vrError ? (
        <p className="screen-reader-only" role="alert">
          {vrError}
        </p>
      ) : null}

      {voiceMessage ? (
        <div className="voice-note-card" role="status">
          <span className="voice-note-card__wave" aria-hidden="true" />
          <p>{voiceMessage}</p>
          <button type="button" onClick={stopVoiceNote} aria-label="Dismiss voice note">
            Close
          </button>
        </div>
      ) : null}

      {activeAnnotation ? (
        <aside className="memory-point-card" role="dialog" aria-label="Memory point">
          <div className="memory-point-card__content">
            <span aria-hidden="true">
              {activeAnnotation.kind === 'voice' ? '◉' : '✦'}
            </span>
            <p>{activeAnnotationDescription}</p>
          </div>
          {activeAnnotation.kind === 'voice' && activeAnnotation.audioUrl ? (
            <audio
              key={activeAnnotation.audioUrl}
              src={activeAnnotation.audioUrl}
              controls
              autoPlay
              aria-label={`Voice note playback: ${activeAnnotationDescription}`}
            />
          ) : null}
          {activeAnnotation.kind === 'voice' && !activeAnnotation.audioUrl ? (
            <p className="memory-point-card__audio-unavailable" role="status">
              This voice note’s audio is unavailable on this device. Check your
              connection, then close and reopen the moment to try again.
            </p>
          ) : null}
          <div className="memory-point-card__actions">
            {sharedMoment ? (
              <button
                type="button"
                onClick={() => {
                  openComments(activeAnnotation.id)
                  setActiveAnnotation(null)
                }}
              >
                Reply
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setActiveAnnotation(null)}
              aria-label="Close memory point"
            >
              Close
            </button>
          </div>
        </aside>
      ) : null}

      <FamilyCommentsPanel
        open={commentsOpen && Boolean(sharedMoment) && !cardboardActive && !vrSetupOpen}
        comments={comments}
        annotations={sharedMoment?.annotations ?? []}
        targetAnnotationId={commentTargetAnnotationId}
        loading={commentsLoading}
        sending={commentsSending}
        error={commentsError}
        onClose={closeComments}
        onTargetChange={setCommentTargetAnnotationId}
        onSubmit={submitComment}
      />

      {pointEditorOpen && sharedMoment?.objectUrl ? (
        <GuidedPanoramaReview
          panoramaUrl={sharedMoment.objectUrl}
          annotations={pointDraft}
          onAnnotationsChange={savePointDraft}
          onContinue={pointEditorError
            ? () => savePointDraft(pointDraft)
            : closePointEditor}
          onRetake={discardPointEditor}
          title="Memory points"
          subtitle="Tap +, then tap a place in the scene"
          retakeLabel="Discard"
          continueLabel={pointEditorError ? 'Retry save' : 'Done'}
          busy={pointEditorSaving}
          actionError={pointEditorError}
          actionMessage={pointEditorSaved ? 'Memory points saved.' : null}
          hideRetake={!pointEditorError}
          modal
        />
      ) : null}
    </section>
  )
}
