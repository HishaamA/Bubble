import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { PanoramaViewer, type PanoramaScene } from '../../viewer'
import { CardboardViewer, type CardboardViewerHandle } from './cardboard'
import { memories } from './memories'
import type { PanoramaMoment } from './shared'

const DEMO_VOICE_NOTE =
  'Sunday dinner always sounds like this: everyone talking, everyone laughing, and nobody ready to leave.'

type PanoramaMemoryScreenProps = {
  sharedMoments?: PanoramaMoment[]
  sharedMomentsLoading?: boolean
}

export function PanoramaMemoryScreen({
  sharedMoments = [],
  sharedMomentsLoading = false,
}: PanoramaMemoryScreenProps = {}) {
  const navigate = useNavigate()
  const { memoryId = 'dinner' } = useParams()
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
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
    : staticMemory ?? memories[4]
  const isDinnerMemory = !sharedMoment && memory.id === 'dinner'
  const sharedMemoryMissing = Boolean(sharedMomentId && !sharedMoment)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      titleRef.current?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [memory.id])

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

  const returnToMemories = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    navigate('/', {
      state: { restoreMemoryId: memory.id },
      viewTransition: true,
    })
  }, [memory.id, navigate])

  const playVoiceNote = useCallback(() => {
    setVoiceMessage(DEMO_VOICE_NOTE)
    if (!('speechSynthesis' in window)) return

    window.speechSynthesis.cancel()
    const note = new SpeechSynthesisUtterance(DEMO_VOICE_NOTE)
    note.rate = 0.92
    note.pitch = 1.02
    window.speechSynthesis.speak(note)
  }, [])

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
        id: 'jordan-pond',
        panorama: isDinnerMemory
          ? '/assets/panoramas/sunday-dinner-demo.jpg'
          : '/assets/panoramas/jordan-pond-demo.jpg',
        alt: isDinnerMemory
          ? 'A warm panoramic family dinner around a candlelit table.'
          : 'A wide panoramic view of Jordan Pond and the surrounding mountains.',
        title: memory.label,
        description: isDinnerMemory
          ? 'A bundled concept panorama for the first KinSphere memory flow.'
          : 'A bundled local panorama used for the first KinSphere viewer proof.',
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
          {
            id: 'doorway-alma',
            kind: 'scene',
            pitch: -2,
            yaw: 34,
            label: 'Enter the second memory',
            sceneId: 'alma-courtyard',
            targetPitch: 2,
            targetYaw: -26,
            targetHfov: 100,
          },
        ],
        },
        {
        id: 'alma-courtyard',
        panorama: '/assets/panoramas/alma-demo.jpg',
        alt: 'A panoramic view of the ALMA radio telescope array beneath a clear blue sky.',
        title: 'The next room',
        description: 'The doorway links to exactly one second bundled panorama.',
        pitch: 2,
        yaw: -26,
        hfov: 100,
        minHfov: 52,
        maxHfov: 120,
        },
      ]
    },
    [isDinnerMemory, memory.label, playVoiceNote, sharedMoment],
  )

  const initialSceneId = scenes[0]?.id

  const transitionStyle = {
    viewTransitionName: `memory-${memory.id}`,
  } as CSSProperties

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
        <p>Return to Memories and choose another family moment.</p>
        <button type="button" onClick={returnToMemories}>
          Back to Memories
        </button>
      </section>
    )
  }

  return (
    <section className="panorama-screen" aria-labelledby="panorama-memory-title">
      <div className="panorama-transition-surface" style={transitionStyle}>
        <PanoramaViewer
          scenes={scenes}
          initialSceneId={initialSceneId}
          ariaLabel={`${memory.label} panoramic memory`}
        />
      </div>

      <CardboardViewer
        ref={cardboardRef}
        scenes={scenes}
        initialSceneId={initialSceneId}
        ariaLabel={`${memory.label} Cardboard panoramic memory`}
      />

      <header className="panorama-top-bar">
        <button type="button" onClick={returnToMemories} aria-label="Back to memories">
          <Icon name="arrow" size={24} />
        </button>
        <div>
          <p className="eyebrow">{memory.date}</p>
          <h1 id="panorama-memory-title" ref={titleRef} tabIndex={-1}>
            {memory.label}
          </h1>
        </div>
        <button
          className="panorama-vr-button"
          type="button"
          onClick={() => void cardboardRef.current?.enter()}
          aria-label="Enter Cardboard VR view"
        >
          <Icon name="vr" size={25} />
        </button>
      </header>

      <p className="screen-reader-only" role="status" aria-live="polite">
        {memory.label} panoramic memory opened.
      </p>

      {voiceMessage ? (
        <div className="voice-note-card" role="status">
          <span className="voice-note-card__wave" aria-hidden="true" />
          <p>{voiceMessage}</p>
          <button type="button" onClick={stopVoiceNote} aria-label="Dismiss voice note">
            Close
          </button>
        </div>
      ) : null}
    </section>
  )
}
