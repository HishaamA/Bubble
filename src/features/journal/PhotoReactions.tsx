import { useEffect, useRef, useState } from 'react'
import {
  fetchPhotoReactions,
  PHOTO_REACTION_EMOJIS,
  setPhotoReaction,
  subscribeToPhotoReactions,
  type PhotoReactionSummary,
} from '../capsules/photoReactionService'
import './PhotoReactions.css'

type PhotoReactionsProps = {
  photoId: string
  storageScope: string
  shared: boolean
}

const reactionNames = ['Love', 'Adore', 'Laugh', 'Wow', 'Applause']

function readLocalReaction(key: string): PhotoReactionSummary[] {
  try {
    const emoji = localStorage.getItem(key)
    return PHOTO_REACTION_EMOJIS.some((candidate) => candidate === emoji)
      ? [{ emoji: emoji!, count: 1, reactedByMe: true }]
      : []
  } catch {
    return []
  }
}

function ReactionState({ photoId, storageScope, shared }: PhotoReactionsProps) {
  const storageKey = `bubble:photo-reaction:v1:${encodeURIComponent(storageScope)}:${encodeURIComponent(photoId)}`
  const [reactions, setReactions] = useState<PhotoReactionSummary[]>(() =>
    shared ? [] : readLocalReaction(storageKey),
  )
  const [loading, setLoading] = useState(shared)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const pending = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    active.current = true
    if (!shared) return () => { active.current = false }

    async function refresh() {
      if (pending.current) return
      const request = ++revision.current
      try {
        const next = await fetchPhotoReactions(photoId)
        if (active.current && request === revision.current) {
          setReactions(next)
          setError('')
        }
      } catch {
        if (active.current && request === revision.current) {
          setError('Couldn’t load reactions. Tap one to try again.')
        }
      } finally {
        if (active.current && request === revision.current) setLoading(false)
      }
    }

    function refreshWhenVisible() {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    void refresh()
    const stop = subscribeToPhotoReactions(photoId, () => void refresh())
    window.addEventListener('online', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      active.current = false
      revision.current += 1
      stop()
      window.removeEventListener('online', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [photoId, shared])

  async function react(emoji: string) {
    if (pending.current || loading) return
    const selected = reactions.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe)
    const nextEmoji = selected ? null : emoji
    if (!shared) {
      try {
        if (nextEmoji) localStorage.setItem(storageKey, nextEmoji)
        else localStorage.removeItem(storageKey)
        setReactions(nextEmoji ? [{ emoji: nextEmoji, count: 1, reactedByMe: true }] : [])
        setError('')
      } catch {
        setError('Couldn’t save your reaction on this device.')
      }
      return
    }
    pending.current = true
    revision.current += 1
    setSending(true)
    setError('')
    try {
      const next = await setPhotoReaction(photoId, nextEmoji)
      if (active.current) setReactions(next)
    } catch {
      if (active.current) setError('Your reaction wasn’t sent. Please try again.')
    } finally {
      pending.current = false
      if (active.current) setSending(false)
    }
  }

  const ownReaction = reactions.find((reaction) => reaction.reactedByMe)
  return (
    <section className="photo-reactions" aria-label="Photo reactions">
      <div className="photo-reactions__heading">
        <span>Send a little love</span>
        <small>{shared ? 'With your family' : 'On this device'}</small>
      </div>
      <div className="photo-reactions__choices" role="group" aria-label="Choose a reaction">
        {PHOTO_REACTION_EMOJIS.map((emoji, index) => {
          const reaction = reactions.find((candidate) => candidate.emoji === emoji)
          return (
            <button
              key={emoji}
              type="button"
              aria-label={`${reactionNames[index]}${reaction?.count ? `, ${reaction.count}` : ''}`}
              aria-pressed={reaction?.reactedByMe ?? false}
              disabled={loading || sending}
              onClick={() => void react(emoji)}
            >
              <span aria-hidden="true">{emoji}</span>
              {reaction?.count ? <small aria-hidden="true">{reaction.count}</small> : null}
            </button>
          )
        })}
      </div>
      <p className="photo-reactions__status" role="status">
        {error || (loading ? 'Loading reactions…' : sending ? 'Sending…' : ownReaction ? 'Tap your reaction again to remove it.' : 'Choose one that feels right.')}
      </p>
    </section>
  )
}

/** Resets private counts and in-flight work when the account or photo changes. */
export function PhotoReactions(props: PhotoReactionsProps) {
  return <ReactionState key={`${props.storageScope}:${props.photoId}:${props.shared}`} {...props} />
}
