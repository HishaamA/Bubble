import { App as CapacitorApp } from '@capacitor/app'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { AppWhimsy } from '../../app/AppWhimsy'
import { useAuth } from '../auth'
import { markWidgetRecapViewed } from '../widgets/widgetStorage'
import '../FeaturePages.css'
import './CapsulesPage.css'
import {
  addLocalDays,
  isCapsuleUnlocked,
  startOfCapsuleWeek,
  toLocalDateInput,
} from './capsuleDates'
import { CapsuleCard, CapsuleLockIcon } from './CapsuleCard'
import { CapsuleRecapSheet } from './recap/CapsuleRecapSheet'
import {
  capsuleDisplayTitle,
  capsuleHasPhotos,
  capsuleRecapPhotos,
  formatWeekRange,
  partitionCapsulesByAge,
} from './capsuleViewModel'
import {
  getCapsuleSession,
  isCapsuleSessionFresh,
  refreshCapsuleSession,
  retainCapsuleSessionDraft,
} from './capsuleSessionCache'
import { subscribeToFamilyCapsules } from './capsuleService'
import { orderCapsules } from './capsuleReconciliation'
import { synchronizeCapsuleSnapshot } from './capsuleSynchronization'
import { getCapsulePhotoCapturedAt } from './capsulePhotoDate'
import { CAPSULES_CHANGED_EVENT, notifyLocalCapsulesChanged } from './capsuleChanges'
import { applyCapsuleRemovals } from './capsuleRemovalState'
import { canDeleteCapsule, removeCapsuleContent } from './capsuleRemovalActions'
import { subscribeToFamilyCapsuleDeletions } from './capsuleDeletionService'
import { ContentRemovalControl } from '../journal/ContentRemovalControl'
import { CapsulePhotoManager } from './CapsulePhotoManager'
import { useHiddenContent, capsuleVisibilityKey, setContentHidden, restoreHiddenContent } from '../journal/contentVisibility'
import { processCapsuleImage } from './processCapsuleImage'
import type {
  CapsulePhoto,
  CapsuleStore,
  FamilyCapsule,
} from './types'

type CapsulesPageProps = {
  now?: Date
  store?: CapsuleStore
  cacheNamespace?: string
  initialRecapId?: string
  initialContributionId?: string
  initialWidgetRequestKey?: string
  widgetStorageSubject?: string
}

/** Creates a UUID suitable for both local drafts and later server reconciliation. */
function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Coordinates weekly and special Capsules across local persistence, family
 * sync, metadata-stripped uploads, and native/browser recap sharing.
 */
export function CapsulesPage(props: CapsulesPageProps = {}) {
  const { isDevelopmentPreview, user } = useAuth()
  const storeSubject = props.cacheNamespace ?? user?.id ?? 'signed-out'
  return (
    <MemberCapsulesPage
      key={storeSubject}
      {...props}
      storeSubject={storeSubject}
      displayName={user?.displayName?.trim() || 'You'}
      contributorAvatarUrl={user?.imageUrl ?? undefined}
      isDevelopmentPreview={isDevelopmentPreview}
    />
  )
}

/** Account-keyed presentation reuses only its bounded session data between tabs. */
function MemberCapsulesPage({
  now,
  store: suppliedStore,
  initialRecapId,
  initialContributionId,
  initialWidgetRequestKey,
  widgetStorageSubject,
  storeSubject,
  displayName,
  contributorAvatarUrl,
  isDevelopmentPreview,
}: CapsulesPageProps & {
  storeSubject: string
  displayName: string
  contributorAvatarUrl?: string
  isDevelopmentPreview?: boolean
}) {
  const session = useMemo(
    () => getCapsuleSession(storeSubject, suppliedStore),
    [storeSubject, suppliedStore],
  )
  const store = session.store
  const hidden = useHiddenContent(storeSubject)
  const [clock, setClock] = useState(() => new Date(now ?? Date.now()))
  const [capsules, setCapsules] = useState<FamilyCapsule[]>(() => applyCapsuleRemovals(session.result?.capsules ?? [], storeSubject))
  const [loading, setLoading] = useState(() => !session.result)
  const [creating, setCreating] = useState(false)
  const [savingSpecialCapsule, setSavingSpecialCapsule] = useState(false)
  const [uploadingCapsuleId, setUploadingCapsuleId] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [activeRecapId, setActiveRecapId] = useState('')
  const [demoRecapId, setDemoRecapId] = useState('')
  const [widgetContributionId, setWidgetContributionId] = useState('')
  const [specialFormErrors, setSpecialFormErrors] = useState<{
    title?: string
    openDate?: string
  }>({})
  const [authoritativeWeeklyId, setAuthoritativeWeeklyId] = useState(() => session.result?.authoritativeWeeklyId ?? '')
  const weekKey = toLocalDateInput(startOfCapsuleWeek(clock))
  const clockRef = useRef(clock)
  const mountedRef = useRef(true)
  const createSpecialCapsuleInFlightRef = useRef(false)
  const refreshedUnlocksRef = useRef(new Set(
    (session.result?.capsules ?? [])
      .filter((capsule) => isCapsuleUnlocked(capsule.opensAt, new Date(session.observedAt)))
      .map((capsule) => `${capsule.id}:${capsule.opensAt}`),
  ))
  const handledInitialRecapRef = useRef('')
  const handledInitialContributionRef = useRef('')
  const pendingWidgetRecapAcknowledgementRef = useRef('')

  useEffect(() => {
    clockRef.current = clock
  }, [clock])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  /** Coalesces concurrent refresh triggers so one snapshot wins each sync cycle. */
  const refreshCapsules = useCallback(async () => {
    const requestNow = clockRef.current
    const result = await refreshCapsuleSession(session, requestNow, () => synchronizeCapsuleSnapshot({
      store,
      displayName,
      now: requestNow,
      localWeekKey: toLocalDateInput(startOfCapsuleWeek(requestNow)),
      isCurrent: () => !session.disposed,
      cacheNamespace: storeSubject,
    }))
    if (mountedRef.current && !session.disposed) {
      // The authorized response already includes media that was open when it
      // began. Only a later closed->open boundary needs another refresh.
      result.capsules.forEach((capsule) => {
        if (isCapsuleUnlocked(capsule.opensAt, new Date(session.observedAt))) {
          refreshedUnlocksRef.current.add(`${capsule.id}:${capsule.opensAt}`)
        }
      })
      setCapsules(applyCapsuleRemovals(result.capsules, storeSubject))
      setAuthoritativeWeeklyId(result.authoritativeWeeklyId)
      // A homescreen recap tap waits for authorized family data, then opens once.
      if (
        initialRecapId
        && handledInitialRecapRef.current !== `${initialWidgetRequestKey ?? 'initial'}:${initialRecapId}`
      ) {
        handledInitialRecapRef.current = `${initialWidgetRequestKey ?? 'initial'}:${initialRecapId}`
        const capsule = result.capsules.find(({ id }) => id === initialRecapId)
        if (
          capsule?.familySynced === true
          && isCapsuleUnlocked(capsule.opensAt, clockRef.current)
          && capsuleRecapPhotos(capsule.photos).length > 0
        ) {
          setDemoRecapId('')
          pendingWidgetRecapAcknowledgementRef.current = capsule.id
          setActiveRecapId(capsule.id)
        }
      }
      if (
        initialContributionId
        && handledInitialContributionRef.current !== `${initialWidgetRequestKey ?? 'initial'}:${initialContributionId}`
      ) {
        handledInitialContributionRef.current = `${initialWidgetRequestKey ?? 'initial'}:${initialContributionId}`
        const capsule = result.capsules.find(({ id }) => id === initialContributionId)
        const opensAt = capsule ? new Date(capsule.opensAt).getTime() : Number.NaN
        const closesAt = capsule ? new Date(capsule.closesAt).getTime() : Number.NaN
        const currentTime = clockRef.current.getTime()
        if (
          capsule?.familySynced === true
          && Number.isFinite(opensAt)
          && Number.isFinite(closesAt)
          && opensAt > currentTime
          && closesAt > currentTime
        ) {
          setWidgetContributionId(capsule.id)
        }
      }
    }
    return result
  }, [
    displayName,
    initialContributionId,
    initialRecapId,
    initialWidgetRequestKey,
    session,
    store,
    storeSubject,
  ])

  useEffect(() => {
    let active = true
    let stop = () => {}
    const changed = () => {
      if (!active) return
      setCapsules((current) => applyCapsuleRemovals(current, storeSubject))
      // A refresh started before a removal must not swallow its follow-up.
      void (async () => {
        if (session.inFlight) await session.inFlight.catch(() => undefined)
        if (active) await refreshCapsules()
      })().catch(() => undefined)
    }
    const localChanged = (event: Event) => {
      if ((event as CustomEvent<{ cacheNamespace: string }>).detail?.cacheNamespace === storeSubject) changed()
    }
    window.addEventListener(CAPSULES_CHANGED_EVENT, localChanged)
    void subscribeToFamilyCapsuleDeletions(changed, storeSubject).then((unsubscribe) => {
      if (active) stop = unsubscribe
      else unsubscribe()
    }).catch(() => undefined)
    return () => { active = false; stop(); window.removeEventListener(CAPSULES_CHANGED_EVENT, localChanged) }
  }, [refreshCapsules, session, storeSubject])

  // A contribution widget tap lands on the exact authorized Capsule and puts
  // keyboard/assistive focus on its photo chooser without auto-opening a
  // system picker outside a trusted user gesture.
  useEffect(() => {
    if (!widgetContributionId) return
    const capsule = capsules.find(({ id }) => id === widgetContributionId)
    if (!capsule || isCapsuleUnlocked(capsule.opensAt, clock)) return
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(`capsule-${widgetContributionId}`)
      card?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      card?.querySelector<HTMLInputElement>('input[type="file"]')
        ?.focus({ preventScroll: true })
      setAnnouncement(`Ready to add a photo to ${capsuleDisplayTitle(capsule)}.`)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [capsules, clock, widgetContributionId])

  // A supplied clock makes tests and previews deterministic; production advances
  // once per minute so reveal states change without a page reload.
  useEffect(() => {
    if (now) return
    const timer = window.setInterval(() => setClock(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [now])

  // Initial hydration keeps its mounted guard because persistence and family
  // bootstrap may finish after the user has navigated away.
  useEffect(() => {
    let active = true
    // Returning to a recently hydrated tab needs no duplicate network or Blob
    // persistence work. Widget destinations still revalidate before opening.
    if (!initialRecapId && !initialContributionId && isCapsuleSessionFresh(session, clockRef.current)) {
      setLoading(false)
      return
    }
    void refreshCapsules()
      .then(() => {
        if (active) setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setAnnouncement('Capsules could not be opened on this device.')
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [initialContributionId, initialRecapId, refreshCapsules, session, weekKey])

  // Realtime events are only refresh hints. The full reconciler remains the one
  // source of ordering, validation, local-byte preservation, and retry behavior.
  useEffect(() => {
    let active = true
    let unsubscribe: () => void = () => undefined
    void subscribeToFamilyCapsules(() => {
      if (active) void refreshCapsules().catch(() => undefined)
    })
      .then((stop) => {
        if (active) unsubscribe = stop
        else stop()
      })
      .catch(() => undefined)
    return () => {
      active = false
      unsubscribe()
    }
  }, [refreshCapsules, storeSubject])

  // Signed URLs and item visibility can change at the exact reveal instant.
  // Refresh each reveal version once instead of polling every render tick.
  useEffect(() => {
    const newlyUnlocked = capsules.filter((capsule) => (
      capsule.familySynced === true &&
      isCapsuleUnlocked(capsule.opensAt, clock) &&
      !refreshedUnlocksRef.current.has(`${capsule.id}:${capsule.opensAt}`)
    ))
    if (newlyUnlocked.length === 0) return
    newlyUnlocked.forEach((capsule) => {
      refreshedUnlocksRef.current.add(`${capsule.id}:${capsule.opensAt}`)
    })
    void (async () => {
      // A refresh that began before this reveal cannot provide its newly
      // authorized media. Let it finish, then refresh only if still needed.
      if (session.inFlight) await session.inFlight.catch(() => undefined)
      if (!mountedRef.current || session.disposed) return
      if (newlyUnlocked.some((capsule) => new Date(capsule.opensAt).getTime() > session.observedAt)) {
        await refreshCapsules()
      }
    })().catch(() => {
      newlyUnlocked.forEach((capsule) => {
        refreshedUnlocksRef.current.delete(`${capsule.id}:${capsule.opensAt}`)
      })
    })
  }, [capsules, clock, refreshCapsules, session])

  // Mobile WebViews can miss browser online/visibility events while suspended,
  // so the native lifecycle signal participates in the same idempotent refresh.
  useEffect(() => {
    let active = true
    let removeNativeListener: (() => Promise<void>) | undefined
    const refreshOnResume = () => {
      const resumedAt = new Date(now ?? Date.now())
      clockRef.current = resumedAt
      setClock(resumedAt)
      void refreshCapsules().catch(() => undefined)
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshOnResume()
    }
    window.addEventListener('online', refreshOnResume)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (active && isActive) refreshOnResume()
    })
      .then((handle) => {
        if (active) removeNativeListener = () => handle.remove()
        else void handle.remove()
      })
      .catch(() => undefined)
    return () => {
      active = false
      window.removeEventListener('online', refreshOnResume)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      void removeNativeListener?.()
    }
  }, [now, refreshCapsules])

  /** Applies an optimistic Capsule replacement before making it durable. */
  async function saveCapsule(nextCapsule: FamilyCapsule) {
    const next = orderCapsules((session.result?.capsules ?? capsules).map((capsule) => (
      capsule.id === nextCapsule.id ? nextCapsule : capsule
    )))
    setCapsules(next)
    // Finish any pre-mutation reconciler before it can overwrite the new local
    // photo. The following explicit refresh must read the durable new record.
    if (session.inFlight) await session.inFlight.catch(() => undefined)
    if (session.disposed) throw new Error('This family session has ended.')
    await store.save(nextCapsule)
    retainCapsuleSessionDraft(session, { capsules: next, authoritativeWeeklyId })
    notifyLocalCapsulesChanged(storeSubject)
  }

  /** Processes one selected photo, stores it locally, then attempts family sync. */
  async function addPhoto(event: ChangeEvent<HTMLInputElement>, capsule: FamilyCapsule) {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (isCapsuleUnlocked(capsule.opensAt, clock)) {
      setAnnouncement('This Capsule is already open, so it can no longer receive photos.')
      return
    }

    setUploadingCapsuleId(capsule.id)
    setAnnouncement('Preparing your photo…')
    try {
      const capturedAt = await getCapsulePhotoCapturedAt(file)
      const processed = await processCapsuleImage(file)
      const latestCapsule = capsules.find(({ id }) => id === capsule.id) ?? capsule
      const caption = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
      const localPhotoId = createId()
      const photo: CapsulePhoto = {
        id: localPhotoId,
        capsuleId: capsule.id,
        image: processed.image,
        thumbnail: processed.thumbnail,
        width: processed.width,
        height: processed.height,
        thumbnailWidth: processed.thumbnailWidth,
        thumbnailHeight: processed.thumbnailHeight,
        caption,
        capturedAt,
        contributorName: displayName,
        contributorAvatarUrl,
        ownedByCurrentUser: true,
        syncStatus: 'pending',
      }
      await saveCapsule({
        ...latestCapsule,
        photos: [...latestCapsule.photos, photo],
        totalPhotoCount: (latestCapsule.totalPhotoCount ?? latestCapsule.photos.length) + 1,
      })
      const refreshed = await refreshCapsules()
      const synced = refreshed.capsules.some((candidate) => (
        candidate.photos.some((candidatePhoto) => (
          candidatePhoto.id === localPhotoId && candidatePhoto.syncStatus === 'synced'
        ))
      ))
      setAnnouncement(
        synced
          ? `${file.name} was shared with your family in ${capsuleDisplayTitle(capsule)}.`
          : `${file.name} is saved on this device and waiting to share with your family.`,
      )
    } catch (reason) {
      setAnnouncement(reason instanceof Error ? reason.message : 'That photo could not be added.')
    } finally {
      setUploadingCapsuleId('')
    }
  }

  /** Creates a durable special Capsule draft and promotes it through normal sync. */
  async function createSpecialCapsule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const title = String(form.get('title') ?? '').trim()
    const openDate = String(form.get('openDate') ?? '')
    const earliestOpenDate = toLocalDateInput(addLocalDays(clockRef.current, 1))
    const errors: { title?: string; openDate?: string } = {}

    if (!title) errors.title = 'Give this Capsule a name.'
    if (!openDate) {
      errors.openDate = 'Choose the day this Capsule should open.'
    } else if (openDate < earliestOpenDate) {
      errors.openDate = 'Choose tomorrow or a later date.'
    }

    if (errors.title || errors.openDate) {
      setSpecialFormErrors(errors)
      const invalidControl = formElement.elements.namedItem(
        errors.title ? 'title' : 'openDate',
      )
      if (invalidControl instanceof HTMLElement) invalidControl.focus()
      return
    }

    const opensAt = new Date(`${openDate}T20:00:00`)
    if (Number.isNaN(opensAt.getTime())) {
      setSpecialFormErrors({ openDate: 'Choose a valid day for this Capsule to open.' })
      return
    }

    setSpecialFormErrors({})

    // A state-only busy flag is too late for two submit events dispatched in
    // the same turn. Acquire the ref before allocating an ID or mutating the
    // optimistic list so one user intent can create at most one durable row.
    if (createSpecialCapsuleInFlightRef.current) return
    createSpecialCapsuleInFlightRef.current = true
    setSavingSpecialCapsule(true)
    const localCapsuleId = createId()
    const special: FamilyCapsule = {
      id: localCapsuleId,
      kind: 'special',
      title,
      createdAt: new Date().toISOString(),
      closesAt: opensAt.toISOString(),
      opensAt: opensAt.toISOString(),
      createdByName: displayName,
      ownedByCurrentUser: true,
      photos: [],
      totalPhotoCount: 0,
      familySynced: false,
    }
    setCapsules((current) => orderCapsules([...current, special]))
    try {
      if (session.inFlight) await session.inFlight.catch(() => undefined)
      if (session.disposed) throw new Error('This family session has ended.')
      await store.save(special)
      retainCapsuleSessionDraft(session, {
        capsules: orderCapsules([...(session.result?.capsules ?? capsules), special]),
        authoritativeWeeklyId,
      })
      notifyLocalCapsulesChanged(storeSubject)
      const refreshed = await refreshCapsules()
      const synced = refreshed.capsules.some((capsule) => (
        capsule.id === localCapsuleId && capsule.familySynced === true
      ))
      setAnnouncement(
        synced
          ? `${title} is ready for family photos.`
          : `${title} is saved on this device and waiting to share with your family.`,
      )
    } catch {
      setAnnouncement('This Capsule could not be saved on this device.')
    } finally {
      createSpecialCapsuleInFlightRef.current = false
      setSavingSpecialCapsule(false)
      setCreating(false)
    }
  }

  /** Opens only a genuinely revealed Capsule in production. */
  function openRecap(capsule: FamilyCapsule) {
    if (!isCapsuleUnlocked(capsule.opensAt, clockRef.current)) return
    setDemoRecapId('')
    setActiveRecapId(capsule.id)
  }

  /** Opens locked media exclusively behind the explicit development-preview gate. */
  function openDemoRecap(capsule: FamilyCapsule) {
    // The preview is a development affordance, never an alternate production
    // unlock path. Guard both the visible trigger and this imperative boundary
    // so a stale handler or programmatic call cannot disclose locked media.
    if (isDevelopmentPreview !== true) return
    if (isCapsuleUnlocked(capsule.opensAt, clockRef.current)) return
    setDemoRecapId(capsule.id)
    setActiveRecapId(capsule.id)
  }

  /** Clears both production and development-preview recap selection state. */
  function closeRecap() {
    setActiveRecapId('')
    setDemoRecapId('')
  }

  const activeRecapCandidate = capsules.find(({ id }) => id === activeRecapId) ?? null
  const activeRecapAllowed = activeRecapCandidate && (
    isCapsuleUnlocked(activeRecapCandidate.opensAt, clock) ||
    (isDevelopmentPreview === true && demoRecapId === activeRecapCandidate.id)
  )
  const activeRecap = activeRecapAllowed && activeRecapCandidate
    ? activeRecapCandidate
    : null
  const { active: activeCapsules, past } = partitionCapsulesByAge(
    capsules.filter((capsule) => !hidden.includes(capsuleVisibilityKey(capsule.id))), clock)
  const currentWeekly = activeCapsules.find(({ id }) => id === authoritativeWeeklyId) ??
    activeCapsules.find((capsule) => capsule.kind === 'weekly' && capsule.weekStart === weekKey)
  const recentWeeklyRecaps = activeCapsules.filter((capsule) => (
    capsule.kind === 'weekly'
    && capsule.id !== currentWeekly?.id
    && isCapsuleUnlocked(capsule.opensAt, clock)
    && capsuleHasPhotos(capsule)
  ))
  // Automatically generated empty weeks do not clutter the family history.
  // Authored special Capsules remain available there even without photos.
  const pastCapsules = past.filter((capsule) => capsule.kind === 'special' || capsuleHasPhotos(capsule))
  const specialCapsules = activeCapsules.filter((capsule) => capsule.kind === 'special')
  const recapSections = [
    { id: 'recent-weekly-capsules-title', title: 'Just opened', label: 'Recently opened Capsules', capsules: recentWeeklyRecaps },
    { id: 'past-capsules-title', title: 'Past Capsules', label: 'Past Capsules', capsules: pastCapsules },
  ]

  function managementActions(capsule: FamilyCapsule) {
    if (!capsule.photos.some((photo) => photo.ownedByCurrentUser)) return null
    return (
      <CapsulePhotoManager
        key={`${storeSubject}:${capsule.id}`}
        capsule={capsule}
        onDelete={async (photoId) => {
          if (uploadingCapsuleId === capsule.id) throw new Error('Please wait for your photo to finish saving, then try again.')
          await removeCapsuleContent({ scope: storeSubject, capsule, photoId, store: suppliedStore })
          setCapsules((current) => applyCapsuleRemovals(current, storeSubject))
        }}
      />
    )
  }

  function removalAction(capsule: FamilyCapsule) {
    // The family's collecting week stays in place; individual contributions
    // remain manageable without removing everyone's current Capsule.
    if (capsule.kind === 'weekly' && !isCapsuleUnlocked(capsule.opensAt, clock)) return null
    const mayDelete = canDeleteCapsule(capsule)
    return (
      <ContentRemovalControl
        key={`${storeSubject}:${capsule.id}`}
        noun="Capsule"
        compact
        hideOnly={!mayDelete}
        description={mayDelete
          ? 'This removes the Capsule and its photos from the app for everyone in your family. Separate Journal uploads and videos already saved to a phone stay unchanged.'
          : 'This hides the Capsule from your Capsule page on this device. Its creator and your family keep it. You can restore hidden items below.'}
        onRemove={async () => {
          if (capsule.kind === 'weekly' && !isCapsuleUnlocked(capsule.opensAt, clockRef.current)) {
            throw new Error('This week is still gathering. You can manage your own photos instead.')
          }
          if (uploadingCapsuleId === capsule.id) throw new Error('Please wait for your photo to finish saving, then try again.')
          if (mayDelete) {
            await removeCapsuleContent({ scope: storeSubject, capsule, store: suppliedStore })
            setCapsules((current) => applyCapsuleRemovals(current, storeSubject))
          } else setContentHidden(storeSubject, capsuleVisibilityKey(capsule.id), true)
          if (activeRecapId === capsule.id) closeRecap()
        }}
      />
    )
  }

  return (
    <section className="ks-feature capsules-page" aria-labelledby="capsules-title">
      <AppWhimsy page="capsule" />
      <header className="ks-feature__header capsule-page-header app-page-header">
        <div className="ks-feature__header-copy">
          <p className="capsule-page-header__eyebrow app-page-header__eyebrow">Our family</p>
          <h1 id="capsules-title">Capsule</h1>
          <p className="app-page-header__subtitle">Small pieces of the week, opened together.</p>
        </div>
        <button
          className="ks-feature__header-action"
          type="button"
          aria-label={creating ? 'Close special Capsule form' : 'Create a special Capsule'}
          aria-expanded={creating}
          disabled={savingSpecialCapsule}
          onClick={() => {
            setSpecialFormErrors({})
            setCreating((value) => !value)
          }}
        >
          {creating ? '×' : '+'}
        </button>
      </header>

      <p className="capsule-page__announcement" role="status" aria-live="polite">{announcement}</p>

      {creating ? (
        <form className="capsule-special-form" noValidate onSubmit={(event) => void createSpecialCapsule(event)}>
          <div>
            <p>Special Capsule</p>
            <h2>Keep one occasion together</h2>
          </div>
          <label className="ks-field">
            <span>Name</span>
            <input
              name="title"
              autoFocus
              maxLength={64}
              placeholder="Grandpa’s 60th"
              required
              aria-invalid={specialFormErrors.title ? 'true' : undefined}
              aria-describedby={specialFormErrors.title ? 'capsule-title-error' : undefined}
              onChange={() => {
                if (specialFormErrors.title) {
                  setSpecialFormErrors((current) => ({ ...current, title: undefined }))
                }
              }}
            />
            {specialFormErrors.title ? (
              <small className="capsule-special-form__error" id="capsule-title-error" role="alert">
                {specialFormErrors.title}
              </small>
            ) : null}
          </label>
          <label className="ks-field">
            <span>Open after</span>
            <input
              name="openDate"
              type="date"
              min={toLocalDateInput(addLocalDays(clock, 1))}
              defaultValue={toLocalDateInput(addLocalDays(clock, 7))}
              required
              aria-invalid={specialFormErrors.openDate ? 'true' : undefined}
              aria-describedby={specialFormErrors.openDate ? 'capsule-date-error' : undefined}
              onChange={() => {
                if (specialFormErrors.openDate) {
                  setSpecialFormErrors((current) => ({ ...current, openDate: undefined }))
                }
              }}
            />
            {specialFormErrors.openDate ? (
              <small className="capsule-special-form__error" id="capsule-date-error" role="alert">
                {specialFormErrors.openDate}
              </small>
            ) : null}
          </label>
          <p>Everyone can add ordinary photos until 8:00 PM on this day.</p>
          <button className="ks-primary-button" type="submit" disabled={savingSpecialCapsule}>
            {savingSpecialCapsule ? 'Creating Capsule…' : 'Create Capsule'}
          </button>
        </form>
      ) : null}

      {loading ? <p className="capsule-page__loading">Opening your family Capsule…</p> : null}

      {currentWeekly ? (
        <section className="capsule-page__section" aria-labelledby="weekly-capsule-title">
          <div className="capsule-section-heading">
            <div>
              <p>This week</p>
              <h2 id="weekly-capsule-title">{formatWeekRange(currentWeekly)}</h2>
            </div>
            <span className="capsule-weekly-unlock">
              <CapsuleLockIcon />
              {isCapsuleUnlocked(currentWeekly.opensAt, clock)
                ? 'Open now'
                : `Unlocks ${new Intl.DateTimeFormat('en', { weekday: 'long' }).format(new Date(currentWeekly.opensAt))}`}
            </span>
            <span className="capsule-visually-hidden">Photos only · not 360°</span>
          </div>
          <CapsuleCard
            capsule={currentWeekly}
            managementActions={managementActions(currentWeekly)}
            removalAction={removalAction(currentWeekly)}
            now={clock}
            uploading={uploadingCapsuleId === currentWeekly.id}
            demoUnlocked={demoRecapId === currentWeekly.id}
            allowLockedPreview={isDevelopmentPreview === true}
            hideHeader
            onChoosePhoto={addPhoto}
            onOpenRecap={openRecap}
            onDemoUnlock={openDemoRecap}
          />
        </section>
      ) : null}

      {recapSections.filter((section) => section.capsules.length > 0).map((section) => (
        <section key={section.id} className="capsule-page__section" data-recap-history="true" aria-labelledby={section.id}>
          <div className="capsule-section-heading">
            <div>
              <p>Opened together</p>
              <h2 id={section.id}>{section.title}</h2>
            </div>
            <span className="capsule-section-heading__view-all" aria-hidden="true">View all ›</span>
            <span className="capsule-visually-hidden">Swipe · play · download</span>
          </div>
          <ul
            className="capsule-weekly-carousel"
            data-single={section.capsules.length === 1 ? 'true' : 'false'}
            aria-label={section.label}
            tabIndex={0}
          >
            {section.capsules.map((capsule) => (
              <li key={capsule.id}>
                <CapsuleCard
                  capsule={capsule}
                  managementActions={managementActions(capsule)}
                  removalAction={removalAction(capsule)}
                  now={clock}
                  uploading={false}
                  demoUnlocked={demoRecapId === capsule.id}
                  allowLockedPreview={isDevelopmentPreview === true}
                  onChoosePhoto={addPhoto}
                  onOpenRecap={openRecap}
                  onDemoUnlock={openDemoRecap}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="capsule-page__section" aria-labelledby="special-capsules-title">
        <div className="capsule-section-heading capsule-section-heading--special">
          <div>
            <p>Birthdays, weddings, reunions</p>
            <h2 id="special-capsules-title">Special Capsules</h2>
          </div>
        </div>
        {specialCapsules.map((capsule) => (
          <CapsuleCard
            key={capsule.id}
            capsule={capsule}
            managementActions={managementActions(capsule)}
            removalAction={removalAction(capsule)}
            now={clock}
            uploading={uploadingCapsuleId === capsule.id}
            demoUnlocked={demoRecapId === capsule.id}
            allowLockedPreview={isDevelopmentPreview === true}
            onChoosePhoto={addPhoto}
            onOpenRecap={openRecap}
            onDemoUnlock={openDemoRecap}
          />
        ))}
        <button
          className="capsule-special-empty"
          type="button"
          aria-label="Make a Capsule for the next big day"
          onClick={() => setCreating(true)}
        >
          <span className="capsule-special-empty__plus" aria-hidden="true">＋</span>
          <span className="capsule-special-empty__copy">
            <strong>Create a special Capsule</strong>
            <small>For birthdays, weddings, and reunions</small>
          </span>
          <span className="capsule-special-empty__arrow" aria-hidden="true">›</span>
        </button>
      </section>

      {hidden.length > 0 ? <button type="button" className="ks-secondary-button"
        onClick={() => restoreHiddenContent(storeSubject)}>Restore hidden items ({hidden.length})</button> : null}
      {activeRecap ? (
        <CapsuleRecapSheet
          capsule={activeRecap}
          demoMode={demoRecapId === activeRecap.id}
          onClose={closeRecap}
          onPlaybackReady={() => {
            if (
              pendingWidgetRecapAcknowledgementRef.current !== activeRecap.id
              || !widgetStorageSubject
            ) return
            markWidgetRecapViewed(widgetStorageSubject, activeRecap.id)
            pendingWidgetRecapAcknowledgementRef.current = ''
          }}
          onPreparePhotos={async () => {
            const refreshed = await refreshCapsules()
            return refreshed.capsules.find(({ id }) => id === activeRecap.id)?.photos ?? []
          }}
        />
      ) : null}
    </section>
  )
}
