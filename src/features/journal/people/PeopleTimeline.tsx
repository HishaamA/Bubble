import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { TimelinePhotoImage } from './TimelinePhotoImage'
import { PersonScrapbookPage } from './PersonScrapbookPage'
import { PeopleTimelineAlbums, PeopleTimelinePeople } from './PeopleTimelinePeople'
import { PeopleTimelinePersonForm, PeopleTimelinePersonManager } from './PeopleTimelinePersonForm'
import { PeopleTimelineViewer } from './PeopleTimelineViewer'
import { JournalPhotoDeleteControl } from '../JournalPhotoDeleteControl'
import { PeopleTimelineDateEditor, PeopleTimelinePhotoTags, PhotoMatchCorrection } from './PeopleTimelinePhotoDetails'
import { PeopleTimelineScanStatus } from './PeopleTimelineScanStatus'
import { GalleryScanStatus } from './GalleryScanStatus'
import { useGalleryScanSession } from './galleryScanSession'
import { scanReferencePortrait, scanTimelineFaces } from './faceRecognition'
import {
  createFaceReviewCandidates,
  createFaceSuggestions,
  migrateLegacyPeopleTimelineState,
  sortTimelinePhotos,
  toPeopleTimelinePhotos,
} from './peopleTimelineHelpers'
import {
  FACE_REVIEW_PERSON_ID,
  faceReviewKey,
  selectEffectivePeopleByPhoto,
  selectEnrolledPersonIds,
  selectFaceReviewPreviews,
  selectFamilyPhotoKeys,
  selectPeoplePhotoAlbums,
  selectVisibleTimelinePhotos,
  type FaceReviewPreview,
} from './peopleTimelineSelectors'
import { usePeopleTimelineSession } from './peopleTimelineSession'
import { attachImportedPhotosToPerson } from './personPhotoImport'
import { removePersonScrapbookProfile } from './personScrapbookStore'
import {
  FACE_SCAN_REVISION,
  ALL_PHOTOS_PERSON_ID,
  FAMILY_PERSON_ID,
  type FaceSuggestion,
  type PeopleTimelinePhoto,
  type PeopleTimelineProps,
  type PeopleTimelineState,
  type TimelineDatePrecision,
} from './types'
import './PeopleTimeline.css'
import { ContentRemovalControl } from '../ContentRemovalControl'
import { useHiddenContent, photoVisibilityKey, setContentHidden, restoreHiddenContent } from '../contentVisibility'
import { PHONE_GALLERY_CLEARED_EVENT, type PhoneGalleryClearedDetail } from '../gallery/phoneGallery'
import { GALLERY_TIMELINE_PREFIX, prunePhoneGalleryMatches } from '../phoneGalleryPhotos'

const REVIEW_PERSON_ID = ALL_PHOTOS_PERSON_ID
const MAX_REFERENCE_PHOTO_BYTES = 25 * 1024 * 1024
const MAX_REFERENCE_PHOTOS_AT_ONCE = 5
const MAX_FACE_REFERENCES_PER_PERSON = 12
const AUTOMATIC_FACE_SCAN_SETTLE_MS = 700

type DateDraft = {
  precision: TimelineDatePrecision
  value: string
}

type ScanProgress = {
  completed: number
  total: number
  saved: number
}

/** Generates a collision-resistant local identifier for people and references. */
function createLocalId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `person-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Formats a local calendar day for date inputs without UTC day drift. */
function localIsoDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Describes how much durable progress remains after an interrupted face scan. */
function stoppedScanMessage(savedPhotoCount: number) {
  return savedPhotoCount > 0
    ? `Scan stopped. Results from ${savedPhotoCount} ${savedPhotoCount === 1 ? 'photo were' : 'photos were'} saved.`
    : 'Scan stopped. No face data was saved.'
}

/** Applies count, type, and size limits before reference-photo decoding starts. */
function referencePhotoError(files: readonly File[]) {
  if (!files.length) return 'Choose at least one clear face photo.'
  if (files.length > MAX_REFERENCE_PHOTOS_AT_ONCE) {
    return `Choose up to ${MAX_REFERENCE_PHOTOS_AT_ONCE} face photos at a time.`
  }
  if (files.some((file) => !file.type.startsWith('image/'))) {
    return 'Choose JPEG, PNG, or WebP photos.'
  }
  if (files.some((file) => file.size <= 0 || file.size > MAX_REFERENCE_PHOTO_BYTES)) {
    return 'Choose face photos smaller than 25 MB each.'
  }
  return ''
}

/** Fingerprints pending work so effects do not restart an unchanged scan queue. */
function automaticScanSignature(
  faceProfiles: PeopleTimelineState['faceProfiles'],
  faceScans: PeopleTimelineState['faceScans'],
  photos: readonly PeopleTimelinePhoto[],
) {
  /*
   * This is a scheduling fingerprint, not a biometric identifier. It changes
   * when the model revision, usable reference count, or an unscanned photo's
   * durable key/source changes. The automatic effect can therefore ignore
   * render churn without permanently suppressing new uploads or revised face
   * models. Embedding values deliberately never enter the signature.
   */
  const profileSignature = Object.entries(faceProfiles)
    .filter(([, profile]) => profile.references.length > 0)
    .map(([personId, profile]) => `${personId}:${profile.references.length}`)
    .sort()
  if (!profileSignature.length) return ''
  const pendingPhotoKeys = photos
    .filter((photo) => photo.origin !== 'device-gallery' && photo.canScanFaces && faceScans[photo.key] === undefined)
    .map((photo) => typeof photo.scanSource === 'string'
      ? `${photo.key}\u0002${photo.scanSource}`
      : photo.key)
    .sort()
  if (!pendingPhotoKeys.length) return ''
  return `${FACE_SCAN_REVISION}\u0003${profileSignature.join('\u0000')}\u0001${pendingPhotoKeys.join('\u0000')}`
}

/** Scans reference files sequentially to bound model and image memory use. */
async function scanReferencePhotos(files: readonly File[]) {
  /*
   * Enrollment Files are intentionally short-lived input capabilities. The
   * face model consumes them in memory and this helper returns only numeric
   * descriptors and quality scores; source image bytes are never copied into
   * People state, IndexedDB, route state, or a remote request.
   */
  const scans: Awaited<ReturnType<typeof scanReferencePortrait>>[] = []
  let firstError: unknown
  for (const file of files) {
    try {
      scans.push(await scanReferencePortrait(file))
    } catch (error) {
      firstError ??= error
    }
  }
  if (!scans.length) throw firstError ?? new Error('No clear face photo could be scanned.')
  return { scans, failed: files.length - scans.length }
}

/** Creates an editable day draft from the photo's original local timestamp. */
function originalDateDraft(photo: PeopleTimelinePhoto): DateDraft {
  const capturedDate = new Date(photo.capturedAt)
  if (!Number.isFinite(capturedDate.getTime())) {
    return { precision: 'year', value: String(new Date().getFullYear()) }
  }
  return { precision: 'day', value: localIsoDate(capturedDate) }
}


/**
 * Coordinates people profiles, face scans, review decisions, manual tagging,
 * corrected dates, and the chronologically grouped family photo timeline.
 */
export function PeopleTimeline({
  photos,
  galleryIndexReady = true,
  journalPhotos = [],
  cacheNamespace,
  className,
  initialPersonId,
  focusMemoryId,
  focusPhotoKey,
  focusRequestKey,
  scrollToFocusedPhoto = false,
  onUploadPhotos,
  onDeletePhoto,
  onDeleteCapsulePhoto,
  photoImportProgress,
  personAlbumOpen = false,
  onOpenPersonAlbum,
  onClosePersonAlbum,
}: PeopleTimelineProps) {
  const {
    state: timelineState,
    ready: cacheReady,
    replace: setTimelineState,
    save: queueTimelineStateSave,
    getSnapshot: getTimelineSnapshot,
  } = usePeopleTimelineSession(cacheNamespace)
  const hidden = useHiddenContent(cacheNamespace)
  const [selectedPersonId, setSelectedPersonId] = useState(initialPersonId ?? FAMILY_PERSON_ID)
  const [activePhotoKey, setActivePhotoKey] = useState<string | null>(null)
  const [addingPerson, setAddingPerson] = useState(false)
  const [newPersonName, setNewPersonName] = useState('')
  const [newPersonPortraits, setNewPersonPortraits] = useState<File[]>([])
  const [addingPersonBusy, setAddingPersonBusy] = useState(false)
  const [addPersonError, setAddPersonError] = useState('')
  const [managingPerson, setManagingPerson] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [referencePortraits, setReferencePortraits] = useState<File[]>([])
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [manageError, setManageError] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [tagEditorOpen, setTagEditorOpen] = useState(false)
  const [dateEditorOpen, setDateEditorOpen] = useState(false)
  const [dateDraft, setDateDraft] = useState<DateDraft>({
    precision: 'year',
    value: '',
  })
  const [dateError, setDateError] = useState('')
  const [confirmingClearFaceData, setConfirmingClearFaceData] = useState(false)
  const [faceDataClearing, setFaceDataClearing] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanMessage, setScanMessage] = useState('')
  const [scanError, setScanError] = useState(false)
  const [photoImportMessage, setPhotoImportMessage] = useState('')
  const [photoImportError, setPhotoImportError] = useState(false)
  const [localImportingPhotos, setLocalImportingPhotos] = useState(false)
  const [postponedFaceReviews, setPostponedFaceReviews] = useState<string[]>([])
  const [showAllFaceMatchedAlbums, setShowAllFaceMatchedAlbums] = useState(false)
  const faceMatchedAlbumsId = useId()

  const scanController = useRef<AbortController | null>(null)
  const scanSavedPhotoCount = useRef(0)
  const timelineStateRef = useRef(timelineState)
  const initialTimelineSelection = useRef(initialPersonId ?? FAMILY_PERSON_ID)
  const photoLinkRef = useRef<HTMLAnchorElement>(null)
  const photoFigureRef = useRef<HTMLElement>(null)

  // Route restoration is intentionally one-shot. These signatures distinguish
  // a newly returned memory/person from ordinary rerenders, while the pending
  // manage ref bridges the scrapbook route closing into its inline editor.
  const restoredPersonSignature = useRef('')
  const restoredFocusSignature = useRef('')
  const restoredLinkFocusSignature = useRef('')
  const manageAfterRouteClosePersonId = useRef('')
  const lastAutomaticScanSignature = useRef('')
  const addPersonScanInFlight = useRef(false)
  const referenceScanInFlight = useRef(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const photoPickerTargetRef = useRef<{ personId: string | null; namespace: string } | null>(null)
  const photoUploadInFlightRef = useRef(false)
  const photoUploadGenerationRef = useRef(0)
  const photoUploadNamespaceRef = useRef(cacheNamespace)
  const addPersonFormRef = useRef<HTMLFormElement>(null)
  const addPersonOpenerRef = useRef<HTMLButtonElement | null>(null)
  const addPersonFocusFrameRef = useRef<number | null>(null)
  const importingPhotos = Boolean(photoImportProgress?.importing || localImportingPhotos)
  const requestedPersonId = initialPersonId ?? FAMILY_PERSON_ID
  const personRequestSignature = `${cacheNamespace}\u0000${focusRequestKey ?? ''}\u0000${requestedPersonId}`
  const focusRequestSignature = `${personRequestSignature}\u0000${focusPhotoKey ?? focusMemoryId ?? ''}`
  const photoPickerBusy = importingPhotos ||
    Boolean(scanProgress) ||
    addingPersonBusy ||
    referenceBusy ||
    faceDataClearing
  // Library matching must never lock the entry point for enrolling another person.
  const photoUploadBusy = !cacheReady || importingPhotos || addingPersonBusy || referenceBusy || faceDataClearing
  const personEditorBusy = !cacheReady || importingPhotos || addingPersonBusy || referenceBusy || faceDataClearing

  const timelinePhotos = useMemo(
    () => toPeopleTimelinePhotos(photos, journalPhotos).filter((photo) => !hidden.includes(photoVisibilityKey(photo.id, photo.kind))),
    [hidden, journalPhotos, photos],
  )
  const galleryScan = useGalleryScanSession(cacheNamespace, galleryIndexReady ? timelinePhotos : undefined,
    addingPerson || managingPerson || addingPersonBusy || referenceBusy || faceDataClearing || Boolean(scanProgress))
  const selectedPerson = timelineState.people.find(
    ({ id }) => id === selectedPersonId,
  )
  const personName = selectedPerson?.name ?? (
    selectedPersonId === REVIEW_PERSON_ID
      ? 'All photos'
      : selectedPersonId === FACE_REVIEW_PERSON_ID
        ? 'Possible matches'
        : 'Family'
  )
  const { automaticMatches, reviewMatches } = useMemo(
    () => {
      const automaticMatches = createFaceSuggestions(timelineState)
      return { automaticMatches, reviewMatches: createFaceReviewCandidates(timelineState,
        undefined, undefined, undefined, automaticMatches) }
    },
    [timelineState],
  )
  const actionableReviewMatches = useMemo(() => {
    const postponed = new Set(postponedFaceReviews)
    const availablePhotos = new Set(timelinePhotos.map(({ key }) => key))
    return reviewMatches.filter((match) => availablePhotos.has(match.photoKey)
      && !postponed.has(faceReviewKey(match)))
  }, [postponedFaceReviews, reviewMatches, timelinePhotos])
  const faceReviewPreviews = useMemo(() => selectFaceReviewPreviews(
    actionableReviewMatches,
    timelinePhotos,
    timelineState.people,
    timelineState.faceScans,
  ), [actionableReviewMatches, timelinePhotos, timelineState.faceScans, timelineState.people])
  const effectivePeopleByPhoto = useMemo(() => selectEffectivePeopleByPhoto(
    timelineState, timelinePhotos, automaticMatches,
  ), [automaticMatches, timelinePhotos, timelineState])
  const manuallyConfirmedLabels = useMemo(() => new Set(timelineState.assignments
    .filter(({ source }) => source === 'manual')
    .map(({ photoKey, personId }) => `${photoKey}\u0000${personId}`)), [timelineState.assignments])
  const enrolledPersonIds = useMemo(
    () => selectEnrolledPersonIds(timelineState.faceProfiles),
    [timelineState.faceProfiles],
  )
  const familyPersonIds = useMemo(() => new Set(timelineState.people.map(({ id }) => id)), [timelineState.people])
  const setupComplete = enrolledPersonIds.size >= 2
  const setupPeople = useMemo(() => [...timelineState.people]
    .sort((first, second) => (
      Number(enrolledPersonIds.has(second.id)) - Number(enrolledPersonIds.has(first.id))
    )), [enrolledPersonIds, timelineState.people])
  const { albums: faceMatchedAlbums, previews: personPreviewById } = useMemo(
    () => selectPeoplePhotoAlbums(timelineState.people, timelinePhotos, effectivePeopleByPhoto),
    [effectivePeopleByPhoto, timelinePhotos, timelineState.people],
  )
  const familyPhotoKeys = useMemo(() => selectFamilyPhotoKeys(
    timelinePhotos, effectivePeopleByPhoto, familyPersonIds,
  ), [effectivePeopleByPhoto, familyPersonIds, timelinePhotos])
  const visiblePhotos = useMemo(() => selectVisibleTimelinePhotos({
    selectedPersonId,
    photos: timelinePhotos,
    reviewMatches: actionableReviewMatches,
    effectivePeople: effectivePeopleByPhoto,
    familyPhotoKeys,
    dateOverrides: timelineState.dateOverrides,
  }), [actionableReviewMatches, effectivePeopleByPhoto, familyPhotoKeys, selectedPersonId, timelinePhotos, timelineState.dateOverrides])
  const scrapbookPerson = personAlbumOpen && initialPersonId
    ? timelineState.people.find(({ id }) => id === initialPersonId)
    : undefined
  const scrapbookPhotos = useMemo(() => {
    if (!scrapbookPerson) return []
    return sortTimelinePhotos(
      timelinePhotos.filter((photo) =>
        effectivePeopleByPhoto.get(photo.key)?.has(scrapbookPerson.id),
      ),
      timelineState.dateOverrides,
    )
  }, [effectivePeopleByPhoto, scrapbookPerson, timelinePhotos, timelineState.dateOverrides])
  const activeIndex = Math.max(
    0,
    activePhotoKey
      ? visiblePhotos.findIndex(({ key }) => key === activePhotoKey)
      : 0,
  )
  const displayedPhoto = visiblePhotos[activeIndex]
  const displayedReviewMatch = selectedPersonId === FACE_REVIEW_PERSON_ID && displayedPhoto
    ? actionableReviewMatches.find(({ photoKey }) => photoKey === displayedPhoto.key)
    : undefined
  const displayedReviewFace = displayedReviewMatch
    ? timelineState.faceScans[displayedReviewMatch.photoKey]?.faces
      .find(({ id }) => id === displayedReviewMatch.faceId)
    : undefined
  const displayedReviewPerson = displayedReviewMatch
    ? timelineState.people.find(({ id }) => id === displayedReviewMatch.personId)
    : undefined
  const hasFaceData = Object.keys(timelineState.faceScans).length > 0 ||
    Object.keys(timelineState.faceProfiles).length > 0 ||
    timelineState.dismissedSuggestions.length > 0 ||
    timelineState.assignments.some(({ source }) => source === 'face-suggestion')
  const pendingScanKey = useMemo(() => automaticScanSignature(
    timelineState.faceProfiles,
    timelineState.faceScans,
    timelinePhotos,
  ), [timelinePhotos, timelineState.faceProfiles, timelineState.faceScans])

  /** Keeps render state and async scan/save readers on the same snapshot. */
  const replaceTimelineState = useCallback((nextState: typeof timelineState) => {
    if (setTimelineState(nextState)) timelineStateRef.current = nextState
    return nextState
  }, [setTimelineState])

  /** Background gallery checkpoints may publish before React commits a new render. */
  const updateTimelineState = useCallback((
    update: (current: typeof timelineState) => typeof timelineState,
  ) => {
    return replaceTimelineState(update(getTimelineSnapshot().state))
  }, [getTimelineSnapshot, replaceTimelineState])

  useEffect(() => {
    timelineStateRef.current = timelineState
  }, [timelineState])

  useEffect(() => {
    const stopGalleryScan = (event: Event) => {
      const detail = (event as CustomEvent<PhoneGalleryClearedDetail>).detail
      if (detail?.cacheNamespace !== cacheNamespace) return
      scanController.current?.abort()
      scanController.current = null
      setScanProgress(null)
      lastAutomaticScanSignature.current = ''
      if (detail.reason !== 'account' && detail.reason !== 'refresh') {
        const cleared = updateTimelineState((state) => prunePhoneGalleryMatches(state, new Set()))
        void queueTimelineStateSave(cleared)
      }
    }
    window.addEventListener(PHONE_GALLERY_CLEARED_EVENT, stopGalleryScan)
    return () => window.removeEventListener(PHONE_GALLERY_CLEARED_EVENT, stopGalleryScan)
  }, [cacheNamespace, queueTimelineStateSave, updateTimelineState])

  const availableGalleryKeys = useMemo(() => new Set(timelinePhotos
    .filter(({ origin }) => origin === 'device-gallery').map(({ key }) => key)), [timelinePhotos])
  const availableGalleryKeysRef = useRef(availableGalleryKeys)
  useEffect(() => {
    const previous = availableGalleryKeysRef.current
    availableGalleryKeysRef.current = availableGalleryKeys
    if ([...previous].some((key) => !availableGalleryKeys.has(key))) {
      scanController.current?.abort()
      scanController.current = null
      setScanProgress(null)
      lastAutomaticScanSignature.current = ''
    }
  }, [availableGalleryKeys])

  useEffect(() => {
    scanController.current?.abort()
    scanController.current = null
    // oxlint-disable-next-line react/set-state-in-effect -- Reset transient scan UI at the account namespace boundary; private state belongs to the scoped session.
    setScanProgress(null)
    setLocalImportingPhotos(false)
    setPhotoImportMessage('')
    setPhotoImportError(false)
    photoUploadNamespaceRef.current = cacheNamespace
    photoUploadGenerationRef.current += 1
    photoUploadInFlightRef.current = false
    // Keep an open OS picker's old namespace until its result is rejected.
    setSelectedPersonId(initialTimelineSelection.current)
    setActivePhotoKey(null)
    setPostponedFaceReviews([])
    setShowAllFaceMatchedAlbums(false)
    restoredPersonSignature.current = ''
    restoredFocusSignature.current = ''
    restoredLinkFocusSignature.current = ''
    manageAfterRouteClosePersonId.current = ''
    lastAutomaticScanSignature.current = ''
    return () => { photoUploadGenerationRef.current += 1 }
  }, [cacheNamespace])

  useEffect(() => {
    if (!cacheReady) return
    const current = getTimelineSnapshot().state
    const migratedState = migrateLegacyPeopleTimelineState(current, timelinePhotos)
    if (migratedState !== current) {
      replaceTimelineState(migratedState)
    }
  }, [cacheReady, getTimelineSnapshot, replaceTimelineState, timelinePhotos])

  useEffect(() => {
    // Face-scan checkpoints persist each completed photo explicitly. Avoid a
    // second full-state IndexedDB write from this general autosave path.
    if (!cacheReady || scanController.current) return
    const snapshot = timelineState
    void queueTimelineStateSave(snapshot)
  }, [cacheReady, queueTimelineStateSave, timelineState])

  useEffect(() => {
    if (
      selectedPersonId !== FAMILY_PERSON_ID &&
      selectedPersonId !== REVIEW_PERSON_ID &&
      selectedPersonId !== FACE_REVIEW_PERSON_ID &&
      !timelineState.people.some(({ id }) => id === selectedPersonId)
    ) {
      // oxlint-disable-next-line react/set-state-in-effect -- Persisted selections can become invalid after profile deletion or hydration.
      setSelectedPersonId(FAMILY_PERSON_ID)
    }
  }, [selectedPersonId, timelineState.people])

  useEffect(() => {
    if (!visiblePhotos.length) {
      // oxlint-disable-next-line react/set-state-in-effect -- The active key must follow the externally hydrated filtered collection.
      setActivePhotoKey(null)
      return
    }
    if (!visiblePhotos.some(({ key }) => key === activePhotoKey)) {
      setActivePhotoKey(visiblePhotos[0]?.key ?? null)
    }
  }, [activePhotoKey, visiblePhotos])

  useEffect(() => {
    if (!cacheReady) return

    /*
     * Managing from a dedicated scrapbook first has to close the route owned by
     * JournalPage. Carry the person ID across that prop transition, then mark
     * the route's default selection as already restored so a later autosave
     * render does not snap the editor back to Family. The rename input's
     * existing autofocus provides the final, visible focus handoff.
     */
    const pendingManagePersonId = !personAlbumOpen
      ? manageAfterRouteClosePersonId.current
      : ''
    const pendingManagePersonExists = timelineState.people.some(
      ({ id }) => id === pendingManagePersonId,
    )
    if (pendingManagePersonExists && selectedPersonId === pendingManagePersonId) {
      manageAfterRouteClosePersonId.current = ''
      restoredPersonSignature.current = personRequestSignature
      return
    }
    if (!personAlbumOpen && manageAfterRouteClosePersonId.current) {
      manageAfterRouteClosePersonId.current = ''
    }

    // Person and memory IDs arrive from router state after returning from a
    // photo. Restore each tuple once; otherwise local chip/scrubber choices
    // would be undone every time a scan checkpoint updates timelineState.
    const personSignature = personRequestSignature
    const restoredPersonId = requestedPersonId === FAMILY_PERSON_ID ||
      requestedPersonId === REVIEW_PERSON_ID ||
      requestedPersonId === FACE_REVIEW_PERSON_ID ||
      timelineState.people.some(({ id }) => id === requestedPersonId)
      ? requestedPersonId
      : FAMILY_PERSON_ID
    if (restoredPersonSignature.current !== personSignature) {
      restoredPersonSignature.current = personSignature
      if (selectedPersonId !== restoredPersonId) {
        // oxlint-disable-next-line react/set-state-in-effect -- Router restoration is an external navigation synchronization.
        setSelectedPersonId(restoredPersonId)
        setActivePhotoKey(null)
      }
    }

    if (!focusMemoryId && !focusPhotoKey) return
    const focusSignature = focusRequestSignature
    if (restoredFocusSignature.current === focusSignature) return
    const focusedPhoto = timelinePhotos.find(({ key, memoryId }) =>
      focusPhotoKey ? key === focusPhotoKey : memoryId === focusMemoryId,
    )
    const belongsToPerson = Boolean(focusedPhoto) && (
      restoredPersonId === REVIEW_PERSON_ID ||
      restoredPersonId === FACE_REVIEW_PERSON_ID ||
      (restoredPersonId === FAMILY_PERSON_ID
        ? familyPhotoKeys.has(focusedPhoto?.key ?? '')
        : effectivePeopleByPhoto.get(focusedPhoto?.key ?? '')?.has(restoredPersonId))
    )
    if (focusedPhoto && belongsToPerson) {
      restoredFocusSignature.current = focusSignature
      setActivePhotoKey(focusedPhoto.key)
    }
  }, [
    cacheNamespace,
    cacheReady,
    effectivePeopleByPhoto,
    familyPhotoKeys,
    focusMemoryId,
    focusPhotoKey,
    focusRequestSignature,
    personRequestSignature,
    requestedPersonId,
    initialPersonId,
    personAlbumOpen,
    selectedPersonId,
    timelinePhotos,
    timelineState.people,
  ])

  useEffect(() => {
    if ((!focusMemoryId && !focusPhotoKey) || !displayedPhoto) return
    const focusSignature = focusRequestSignature
    if (
      restoredFocusSignature.current !== focusSignature ||
      restoredLinkFocusSignature.current === focusSignature ||
      (focusPhotoKey ? displayedPhoto.key !== focusPhotoKey : displayedPhoto.memoryId !== focusMemoryId)
    ) return

    // Wait until the restored photo surface has replaced the prior route's
    // subtree. Focusing in the frame avoids losing focus to unmount cleanup and
    // `preventScroll` preserves the Journal position the user came back to.
    const frame = window.requestAnimationFrame(() => {
      restoredLinkFocusSignature.current = focusSignature
      const photoSurface = photoLinkRef.current ?? photoFigureRef.current
      photoSurface?.focus({ preventScroll: true })
      if (scrollToFocusedPhoto && photoSurface) {
        const chrome = photoSurface.closest('.journal-page')
          ?.querySelector('.journal-page__chrome')
        const pinned = chrome && ['sticky', 'fixed'].includes(getComputedStyle(chrome).position)
        photoSurface.style.scrollMarginTop = pinned
          ? `${chrome.getBoundingClientRect().height + 16}px`
          : 'calc(var(--safe-area-top, env(safe-area-inset-top, 0px)) + 16px)'
        photoSurface.scrollIntoView?.({ block: 'start', behavior: 'instant' })
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [displayedPhoto, focusMemoryId, focusPhotoKey, focusRequestSignature, scrollToFocusedPhoto])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Editors are scoped to the externally selected photo record.
    setTagEditorOpen(false)
    setDateEditorOpen(false)
    setDateError('')
  }, [displayedPhoto?.key])

  // A face scan owns model work and Blob/image resources outside React. Abort
  // it on unmount so late checkpoints cannot retain those objects or update a
  // timeline that is no longer visible.
  useEffect(() => () => {
    const activeController = scanController.current
    activeController?.abort()
    if (scanController.current === activeController) scanController.current = null
    if (addPersonFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(addPersonFocusFrameRef.current)
    }
  }, [])

  /** Selects a person and their first matched photo without changing routes. */
  function choosePerson(personId: string) {
    // A later network refresh must not yank the user back to a widget photo
    // after they have already started browsing a different timeline.
    restoredPersonSignature.current = personRequestSignature
    restoredFocusSignature.current = focusRequestSignature
    restoredLinkFocusSignature.current = focusRequestSignature
    setSelectedPersonId(personId)
    setActivePhotoKey(null)
    setManagingPerson(false)
    setConfirmingDelete(false)
    setReferencePortraits([])
    setManageError('')
  }

  /** Opens the selected person's standalone scrapbook route. */
  function openPersonAlbum(personId: string) {
    if (onOpenPersonAlbum) {
      onOpenPersonAlbum(personId)
      return
    }
    choosePerson(personId)
  }

  /** Returns from a scrapbook and opens that person's inline management panel. */
  function managePersonFromScrapbook(personId: string) {
    if (!onClosePersonAlbum) return
    const person = timelineStateRef.current.people.find(({ id }) => id === personId)
    if (!person) return
    manageAfterRouteClosePersonId.current = personId
    startManagingPerson(person)
    onClosePersonAlbum()
  }

  /** Restores focus after the add-person form has unmounted. */
  function restoreAddPersonOpenerFocus() {
    const opener = addPersonOpenerRef.current
    if (!opener) return
    if (addPersonFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(addPersonFocusFrameRef.current)
    }
    // The inline form must unmount before its invoking control can receive
    // focus reliably. Preserve the exact entry point because both the people
    // rail and empty scrapbook card can launch the same editor.
    addPersonFocusFrameRef.current = window.requestAnimationFrame(() => {
      addPersonFocusFrameRef.current = null
      if (opener.isConnected && !opener.disabled) opener.focus()
    })
  }

  /** Closes and resets the add-person workflow before restoring its opener. */
  function closeAddPerson() {
    setAddingPerson(false)
    setNewPersonPortraits([])
    setAddPersonError('')
    restoreAddPersonOpenerFocus()
  }

  /** Records the exact invoking control before showing the add-person form. */
  function openAddPerson(event: MouseEvent<HTMLButtonElement>) {
    if (personEditorBusy) return
    interruptScanForEditor()
    addPersonOpenerRef.current = event.currentTarget
    setAddingPerson(true)
    setAddPersonError('')
    setNewPersonPortraits([])
    setManagingPerson(false)
  }

  /** Forwards the styled upload action to the hidden native file input. */
  function openPhotoPicker() {
    if (photoUploadBusy || photoUploadInFlightRef.current) return
    interruptScanForEditor('choose photos')
    photoPickerTargetRef.current = {
      personId: (personAlbumOpen ? scrapbookPerson?.id : selectedPerson?.id) ?? null,
      namespace: cacheNamespace,
    }
    photoInputRef.current?.click()
  }

  /** Imports selected photos and reports partial failures without losing successes. */
  async function addJournalPhotos(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    input.value = ''
    const pickerTarget = photoPickerTargetRef.current
    photoPickerTargetRef.current = null
    if (!files.length || !onUploadPhotos || photoUploadBusy || photoUploadInFlightRef.current
      || (pickerTarget && pickerTarget.namespace !== cacheNamespace)) return
    const targetPersonId = pickerTarget ? pickerTarget.personId
      : (personAlbumOpen ? scrapbookPerson?.id : selectedPerson?.id) ?? null
    const targetPerson = timelineState.people.find(({ id }) => id === targetPersonId)
    const generation = photoUploadGenerationRef.current
    photoUploadInFlightRef.current = true
    setLocalImportingPhotos(true)
    interruptScanForEditor('add photos')

    if (!targetPerson) choosePerson(REVIEW_PERSON_ID)
    setPhotoImportError(false)
    setPhotoImportMessage(
      `Adding ${files.length} ${files.length === 1 ? 'photo' : 'photos'}…`,
    )
    try {
      const result = await onUploadPhotos(files)
      // The library survives tab navigation. Finish photo membership in its
      // captured private session even if this view unmounted, but never after
      // an account switch/disposal. Only mounted views receive UI updates.
      if (photoUploadNamespaceRef.current !== cacheNamespace) return
      if (targetPerson && (result.added > 0 || result.photoIds?.length)) {
        const photoIds = [...new Set(result.photoIds ?? [])]
        if (!photoIds.length || !getTimelineSnapshot().state.people.some(({ id }) => id === targetPerson.id)) {
          if (generation !== photoUploadGenerationRef.current) return
          setPhotoImportError(true)
          setPhotoImportMessage('The photos are saved in All photos, but could not be linked to this person. Open All photos to label them; do not upload them again.')
          return
        }
        const next = attachImportedPhotosToPerson(getTimelineSnapshot().state, targetPerson.id, photoIds)
        if (!setTimelineState(next)) return
        const saved = await queueTimelineStateSave(next, () => photoUploadNamespaceRef.current === cacheNamespace)
        if (generation !== photoUploadGenerationRef.current) return
        setActivePhotoKey(`journal-photo:${photoIds[0]}`)
        setPhotoImportError(result.failed > 0 || !saved)
        setPhotoImportMessage(saved
          ? `${photoIds.length} ${photoIds.length === 1 ? 'photo added' : 'photos added'} to ${targetPerson.name}’s scrapbook${result.failed ? ` · ${result.failed} could not be added` : ''}.`
          : 'Photos are saved, but the person labels could not be saved on this device. Keep Journal open and try again from All photos.')
        return
      }
      if (generation !== photoUploadGenerationRef.current) return
      const addedLabel = `${result.added} ${result.added === 1 ? 'photo' : 'photos'} added`
      const failedLabel = result.failed > 0
        ? ` · ${result.failed} could not be added`
        : ''
      if (result.added === 0) {
        setPhotoImportError(true)
        setPhotoImportMessage(
          'No photos were added. Try regular JPEG, PNG, or WebP images smaller than 25 MB.',
        )
      } else {
        setPhotoImportError(result.failed > 0)
        const hasEnrolledFace = Object.keys(
          timelineStateRef.current.faceProfiles,
        ).length > 0
        setPhotoImportMessage(
          `${addedLabel}${failedLabel}. Saved on this device; family sharing continues securely in the background. ${hasEnrolledFace
            ? 'Face matching will start on this device.'
            : 'Add a family face when you are ready to organize them.'}`,
        )
      }
    } catch {
      if (generation !== photoUploadGenerationRef.current) return
      setPhotoImportError(true)
      setPhotoImportMessage(
        'Those photos could not be saved on this device. Check free storage and try again.',
      )
    } finally {
      if (generation === photoUploadGenerationRef.current) {
        photoUploadInFlightRef.current = false
        setLocalImportingPhotos(false)
      }
    }
  }

  /** Scans references first, then adds the person and profile in one state update. */
  async function addPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const name = newPersonName.trim()
    if (!name) {
      setAddPersonError('Enter a name.')
      return
    }
    if (timelineState.people.some((person) => person.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setAddPersonError('That person is already here.')
      return
    }
    const portraitError = referencePhotoError(newPersonPortraits)
    if (portraitError) {
      setAddPersonError(portraitError)
      return
    }
    interruptScanForEditor()

    // Disabled state is committed on a later render. A hardware key and click,
    // or two synthetic submits, can reach this handler in the same turn; take a
    // synchronous latch before starting an expensive scan or allocating IDs.
    if (addPersonScanInFlight.current) return
    addPersonScanInFlight.current = true
    setAddingPersonBusy(true)
    setAddPersonError('')
    try {
      const { scans, failed } = await scanReferencePhotos(newPersonPortraits)
      if (!getTimelineSnapshot().ready) return // The originating account may have departed.
      const person = { id: createLocalId(), name, createdAt: new Date().toISOString() }
      updateTimelineState((current) => ({
        ...current,
        people: [...current.people, person],
        faceProfiles: {
          ...current.faceProfiles,
          [person.id]: {
            references: scans.map((scan) => ({
              id: createLocalId(),
              embedding: scan.embedding,
              quality: scan.quality,
              source: 'enrollment' as const,
              createdAt: new Date().toISOString(),
            })),
          },
        },
      }))
      setNewPersonName('')
      setNewPersonPortraits([])
      setAddingPerson(false)
      form.reset()
      choosePerson(person.id)
      if (form.contains(document.activeElement)) restoreAddPersonOpenerFocus()
      setScanMessage(
        timelinePhotos.length > 0
          ? `${name} is ready with ${scans.length} face ${scans.length === 1 ? 'view' : 'views'}. Organizing matching photos on this device…${failed ? ` ${failed} unclear photo${failed === 1 ? ' was' : 's were'} skipped.` : ''}`
          : `${name} is ready. Add family photos to organize automatically.`,
      )
    } catch (error) {
      setAddPersonError(
        error instanceof Error
          ? error.message
          : 'That face photo could not be scanned. Try another clear portrait.',
      )
    } finally {
      addPersonScanInFlight.current = false
      setAddingPersonBusy(false)
    }
  }

  /** Opens management for a person and optionally preserves the invoking control. */
  function startManagingPerson(
    person: PeopleTimelineState['people'][number] | undefined = selectedPerson,
  ) {
    if (!person) return
    interruptScanForEditor()
    setSelectedPersonId(person.id)
    setActivePhotoKey(null)
    setAddingPerson(false)
    setRenameDraft(person.name)
    setManageError('')
    setReferencePortraits([])
    setConfirmingDelete(false)
    setManagingPerson(true)
  }

  /** Selects one ambiguous detected face for an explicit identity decision. */
  function openFaceReview(preview: FaceReviewPreview) {
    choosePerson(FACE_REVIEW_PERSON_ID)
    setActivePhotoKey(preview.photo.key)
  }

  /** Saves a trimmed, non-empty person name while retaining their stable ID. */
  function renamePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedPerson) return
    const name = renameDraft.trim()
    if (!name) {
      setManageError('Enter a name.')
      return
    }
    if (timelineState.people.some((person) =>
      person.id !== selectedPerson.id &&
      person.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )) {
      setManageError('That person is already here.')
      return
    }
    updateTimelineState((current) => ({
      ...current,
      people: current.people.map((person) =>
        person.id === selectedPerson.id ? { ...person, name } : person,
      ),
    }))
    setManageError('')
  }

  /** Validates and appends bounded reference appearances for the managed person. */
  async function saveReferencePortrait(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedPerson) return
    const form = event.currentTarget
    const portraitError = referencePhotoError(referencePortraits)
    if (portraitError) {
      setManageError(portraitError)
      return
    }
    interruptScanForEditor()

    // The ref closes the same-turn gap before `referenceBusy` disables the
    // form. Without it, duplicate activation would scan the same private File
    // twice and append indistinguishable enrollment vectors twice.
    if (referenceScanInFlight.current) return
    referenceScanInFlight.current = true
    const personId = selectedPerson.id
    const personLabel = selectedPerson.name
    setReferenceBusy(true)
    setManageError('')
    try {
      const { scans, failed } = await scanReferencePhotos(referencePortraits)
      if (!getTimelineSnapshot().ready || !getTimelineSnapshot().state.people.some(({ id }) => id === personId)) return
      updateTimelineState((current) => ({
        ...current,
        faceProfiles: {
          ...current.faceProfiles,
          [personId]: {
            references: [
              ...(current.faceProfiles[personId]?.references ?? []),
              ...scans.map((scan) => ({
                id: createLocalId(),
                embedding: scan.embedding,
                quality: scan.quality,
                source: 'enrollment' as const,
                createdAt: new Date().toISOString(),
              })),
            ].slice(-MAX_FACE_REFERENCES_PER_PERSON),
          },
        },
        dismissedSuggestions: current.dismissedSuggestions.filter(
          ({ personId: dismissedPersonId }) => dismissedPersonId !== personId,
        ),
      }))
      lastAutomaticScanSignature.current = ''
      setReferencePortraits([])
      form.reset()
      setScanMessage(`${scans.length} new face ${scans.length === 1 ? 'view' : 'views'} added for ${personLabel}. Matching photos are being reorganized.${failed ? ` ${failed} unclear photo${failed === 1 ? ' was' : 's were'} skipped.` : ''}`)
    } catch (error) {
      setManageError(
        error instanceof Error
          ? error.message
          : 'That face photo could not be scanned. Try another clear portrait.',
      )
    } finally {
      referenceScanInFlight.current = false
      setReferenceBusy(false)
    }
  }

  /** Removes a person plus every assignment, profile, and dismissal referencing them. */
  function deleteSelectedPerson() {
    if (!selectedPerson) return
    removePersonScrapbookProfile(cacheNamespace, selectedPerson.id)
    updateTimelineState((current) => {
      const faceProfiles = { ...current.faceProfiles }
      delete faceProfiles[selectedPerson.id]
      return {
        ...current,
        people: current.people.filter(({ id }) => id !== selectedPerson.id),
        assignments: current.assignments.filter(
          ({ personId }) => personId !== selectedPerson.id,
        ),
        faceProfiles,
        dismissedSuggestions: current.dismissedSuggestions.filter(
          ({ personId }) => personId !== selectedPerson.id,
        ),
      }
    })
    choosePerson(FAMILY_PERSON_ID)
  }

  /** Explicit whole-photo label correction; originals and other people remain unchanged. */
  function setPhotoPersonTag(photoKey: string, personId: string, tagged: boolean) {
    updateTimelineState((current) => {
      const withoutTag = current.assignments.filter((assignment) => !(
        assignment.photoKey === photoKey && assignment.personId === personId
      ))
      const withoutDismissal = current.dismissedSuggestions.filter((dismissal) => !(
        dismissal.photoKey === photoKey && dismissal.personId === personId
      ))
      return {
        ...current,
        assignments: tagged
          ? [...withoutTag, {
              photoKey,
              personId,
              source: 'manual',
              confirmedAt: new Date().toISOString(),
            }]
          : withoutTag,
        // A manually confirmed label may suppress automatic proposals today.
        // Remember an explicit untag regardless, so it cannot reappear later.
        dismissedSuggestions: !tagged
          ? [...withoutDismissal, {
              photoKey,
              personId,
              dismissedAt: new Date().toISOString(),
            }]
          : withoutDismissal,
      }
    })
  }

  function renderPhotoCorrections(photo: PeopleTimelinePhoto, personId?: string) {
    const automaticallyAssigned = timelineState.people.filter((person) =>
      (!personId || person.id === personId)
      && effectivePeopleByPhoto.get(photo.key)?.has(person.id)
      && !manuallyConfirmedLabels.has(`${photo.key}\u0000${person.id}`))
    return automaticallyAssigned.map((person) => (
      <PhotoMatchCorrection key={`${cacheNamespace}:${photo.key}:${person.id}`} personName={person.name}
        photoDescription={photo.caption || 'this photo'}
        onCorrect={() => setPhotoPersonTag(photo.key, person.id, false)} />
    ))
  }

  /** Accepts, reassigns, or dismisses one face-specific review candidate. */
  function reviewFaceMatch(
    suggestion: FaceSuggestion,
    decision: 'yes' | 'no' | 'unsure',
  ) {
    if (decision === 'unsure') {
      setPostponedFaceReviews((current) => [
        ...new Set([...current, faceReviewKey(suggestion)]),
      ])
      return
    }
    updateTimelineState((current) => {
      /** Matches the exact reviewed face/person tuple without affecting siblings. */
      const sameFace = (entry: { photoKey: string; personId: string; faceId?: string }) =>
        entry.photoKey === suggestion.photoKey &&
        entry.personId === suggestion.personId &&
        entry.faceId === suggestion.faceId
      return {
        ...current,
        assignments: decision === 'yes'
          ? [
              ...current.assignments.filter((assignment) => !sameFace(assignment)),
              {
                photoKey: suggestion.photoKey,
                faceId: suggestion.faceId,
                personId: suggestion.personId,
                source: 'manual' as const,
                confirmedAt: new Date().toISOString(),
              },
            ]
          : current.assignments.filter((assignment) => !sameFace(assignment)),
        dismissedSuggestions: decision === 'no'
          ? [
              ...current.dismissedSuggestions.filter((dismissal) => !sameFace(dismissal)),
              {
                photoKey: suggestion.photoKey,
                faceId: suggestion.faceId,
                personId: suggestion.personId,
                dismissedAt: new Date().toISOString(),
              },
            ]
          : current.dismissedSuggestions.filter((dismissal) => !sameFace(dismissal)),
      }
    })
  }

  /** Seeds the date editor from an existing override or original timestamp. */
  function beginDateEdit() {
    if (!displayedPhoto) return
    setDateDraft(
      timelineState.dateOverrides[displayedPhoto.key] ?? originalDateDraft(displayedPhoto),
    )
    setDateError('')
    setDateEditorOpen(true)
  }

  /** Switches date precision while retaining a sensible value for that mode. */
  function changeDatePrecision(precision: TimelineDatePrecision) {
    if (!displayedPhoto) return
    const fallback = originalDateDraft(displayedPhoto)
    const currentYear = dateDraft.value.slice(0, 4) || fallback.value.slice(0, 4)
    setDateDraft({
      precision,
      value: precision === 'year'
        ? currentYear
        : /^\d{4}-\d{2}-\d{2}$/.test(dateDraft.value)
          ? dateDraft.value
          : `${currentYear}-07-01`,
    })
    setDateError('')
  }

  /** Validates and saves the active photo's day or approximate-year correction. */
  function saveDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!displayedPhoto) return
    if (dateDraft.precision === 'year') {
      const year = Number.parseInt(dateDraft.value, 10)
      if (!/^\d{4}$/.test(dateDraft.value) || year < 1800 || year > new Date().getFullYear() + 1) {
        setDateError('Enter a four-digit year.')
        return
      }
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDraft.value) || !Number.isFinite(new Date(`${dateDraft.value}T12:00:00`).getTime())) {
      setDateError('Enter a valid date.')
      return
    }
    updateTimelineState((current) => ({
      ...current,
      dateOverrides: {
        ...current.dateOverrides,
        [displayedPhoto.key]: dateDraft,
      },
    }))
    setDateEditorOpen(false)
    setDateError('')
  }

  /** Removes the active override so the original capture timestamp is used again. */
  function restoreCapturedDate() {
    if (!displayedPhoto) return
    updateTimelineState((current) => {
      const dateOverrides = { ...current.dateOverrides }
      delete dateOverrides[displayedPhoto.key]
      return { ...current, dateOverrides }
    })
    setDateEditorOpen(false)
  }

  /** Runs one cancellable face-scan pass with durable per-photo checkpoints. */
  const scanPhotos = useCallback(async (
    automatic = false,
    expectedAutomaticSignature = '',
  ) => {
    if (scanController.current || scanProgress) return
    if (!Object.keys(timelineStateRef.current.faceProfiles).length) {
      if (!automatic) setScanMessage('Add a face photo for someone before checking uploads.')
      return
    }
    const unscannedPhotos = timelinePhotos.filter((photo) =>
      photo.origin !== 'device-gallery' && photo.canScanFaces && timelineStateRef.current.faceScans[photo.key] === undefined,
    )
    setScanError(false)
    if (!unscannedPhotos.length) {
      if (!automatic) setScanMessage('Face matching is up to date.')
      return
    }
    const currentAutomaticSignature = automatic
      ? automaticScanSignature(
          timelineStateRef.current.faceProfiles,
          timelineStateRef.current.faceScans,
          timelinePhotos,
        )
      : ''
    if (
      automatic &&
      (!currentAutomaticSignature || (
        expectedAutomaticSignature &&
        expectedAutomaticSignature !== currentAutomaticSignature
      ))
    ) return

    /*
     * One controller identifies one library pass. Checkpoints are persisted
     * independently so cancellation keeps completed work, while controller
     * identity prevents an older pass's finally block from clearing a newer
     * one. `scanSavedPhotoCount` reports durability, not merely model output.
     */
    const controller = new AbortController()
    scanController.current = controller
    if (automatic) lastAutomaticScanSignature.current = currentAutomaticSignature
    scanSavedPhotoCount.current = 0
    setScanProgress({ completed: 0, total: unscannedPhotos.length, saved: 0 })
    setPhotoImportMessage('')
    setPhotoImportError(false)
    setScanMessage('Loading the private on-device face models…')
    try {
      const result = await scanTimelineFaces(
        unscannedPhotos,
        async (checkpoint) => {
          if (controller.signal.aborted) return
          if (checkpoint.photoKey.startsWith(GALLERY_TIMELINE_PREFIX) &&
            !availableGalleryKeysRef.current.has(checkpoint.photoKey)) return
          setScanMessage(
            `Checking photo ${checkpoint.completed} of ${checkpoint.total} on this device…`,
          )
          if (!checkpoint.failed) {
            const checkpointState = updateTimelineState((current) => ({
              ...current,
              faceScans: {
                ...current.faceScans,
                // A successful no-face scan has an empty `faces` collection.
                // Failed or partial reads stay pending for a later retry.
                [checkpoint.photoKey]: checkpoint.faceScan ?? {
                  scannedAt: new Date().toISOString(),
                  faces: [],
                },
              },
            }))
            const persisted = await queueTimelineStateSave(checkpointState)
            if (persisted) scanSavedPhotoCount.current += 1
          }
          if (controller.signal.aborted) {
            setScanMessage(stoppedScanMessage(scanSavedPhotoCount.current))
            return
          }
          setScanProgress({
            completed: checkpoint.completed,
            total: checkpoint.total,
            saved: scanSavedPhotoCount.current,
          })
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      const successfulPhotoCount = result.completedPhotoCount - result.failedPhotoCount
      if (
        result.completedPhotoCount > 0 &&
        result.failedPhotoCount === result.completedPhotoCount
      ) {
        setScanError(true)
        setScanMessage('These photos could not be scanned. Manual tagging still works.')
      } else if (result.failedPhotoCount > 0) {
        setScanError(true)
        setScanMessage(
          `${successfulPhotoCount} ${successfulPhotoCount === 1 ? 'photo was' : 'photos were'} organized; ${result.failedPhotoCount} could not be read. You can still tag people in All photos.`,
        )
      } else {
        setScanMessage('Photos are organized. New uploads will be matched automatically.')
      }
    } catch {
      if (!controller.signal.aborted) {
        setScanError(true)
        setScanMessage('Face matching is unavailable right now. Manual tagging still works in All photos.')
      }
    } finally {
      if (scanController.current === controller) {
        lastAutomaticScanSignature.current = automaticScanSignature(
          timelineStateRef.current.faceProfiles,
          timelineStateRef.current.faceScans,
          timelinePhotos,
        )
        if (!controller.signal.aborted) setScanProgress(null)
        scanController.current = null
      }
    }
  }, [queueTimelineStateSave, scanProgress, timelinePhotos, updateTimelineState])

  /** Aborts model work and fingerprints the remaining queue to prevent auto-restart. */
  function cancelFaceScan() {
    const savedPhotoCount = scanSavedPhotoCount.current
    scanController.current?.abort()
    scanController.current = null
    // Fingerprint the remaining work after the last durable checkpoint. This
    // suppresses an immediate effect-driven restart, but a new upload or face
    // reference produces a different signature and remains eligible later.
    lastAutomaticScanSignature.current = automaticScanSignature(
      timelineStateRef.current.faceProfiles,
      timelineStateRef.current.faceScans,
      timelinePhotos,
    )
    setScanProgress(null)
    setScanError(false)
    setScanMessage(stoppedScanMessage(savedPhotoCount))
  }

  /** Editing takes priority; the serialized model finishes/aborts its current image safely. */
  function interruptScanForEditor(activity = 'add a face') {
    if (!scanController.current) return
    scanController.current.abort()
    scanController.current = null
    lastAutomaticScanSignature.current = ''
    setScanProgress(null)
    setScanMessage(`Photo checking is paused while you ${activity}. Saved results are kept.`)
  }

  /** Clears all private face vectors while preserving manual people and dates. */
  async function clearFaceData() {
    lastAutomaticScanSignature.current = ''
    const clearedState = updateTimelineState((current) => ({
      ...current,
      assignments: current.assignments
        .filter(({ source }) => source === 'manual')
        .map(({ faceId: _faceId, ...assignment }) => assignment),
      faceScans: {},
      faceProfiles: {},
      dismissedSuggestions: [],
    }))
    setConfirmingClearFaceData(false)
    setFaceDataClearing(true)
    setScanError(false)
    setScanMessage('Clearing saved face data from this device…')
    const persisted = await queueTimelineStateSave(clearedState)
    setFaceDataClearing(false)
    setScanError(!persisted)
    setScanMessage(
      persisted
        ? 'Face references and detections have been cleared from this device.'
        : 'Face data is cleared for this session, but device storage could not be updated. Try again before leaving Journal.',
    )
  }

  useEffect(() => {
    if (
      !cacheReady ||
      !pendingScanKey ||
      importingPhotos ||
      scanController.current ||
      scanProgress ||
      addingPersonBusy ||
      addingPerson ||
      managingPerson ||
      referenceBusy ||
      faceDataClearing ||
      lastAutomaticScanSignature.current === pendingScanKey
    ) return

    // Journal navigation should get a quiet frame before local model loading
    // begins. Cleanup cancels the delayed pass when the route unmounts or its
    // pending work changes; the signature is only claimed inside scanPhotos
    // after a controller and a still-current queue have actually been created.
    const settleTimer = window.setTimeout(() => {
      void scanPhotos(true, pendingScanKey)
    }, AUTOMATIC_FACE_SCAN_SETTLE_MS)
    return () => window.clearTimeout(settleTimer)
  }, [
    addingPerson,
    managingPerson,
    addingPersonBusy,
    cacheReady,
    faceDataClearing,
    importingPhotos,
    pendingScanKey,
    referenceBusy,
    scanPhotos,
    scanProgress,
  ])

  const rootClassName = ['people-timeline', className].filter(Boolean).join(' ')
  const isNamedPersonAlbum = Boolean(selectedPerson)
  const isFaceReview = selectedPersonId === FACE_REVIEW_PERSON_ID
  const photoInput = onUploadPhotos ? <input ref={photoInputRef} hidden tabIndex={-1} aria-hidden="true"
    data-testid="family-photo-input" type="file" accept="image/*" multiple disabled={photoUploadBusy}
    onChange={(event) => void addJournalPhotos(event)} /> : null
  const photoImportStatus = photoImportProgress?.importing ? (
    <div className="people-timeline__import-progress" role="progressbar" aria-label="Adding family photos"
      aria-valuemin={0} aria-valuemax={photoImportProgress.total} aria-valuenow={photoImportProgress.completed}>
      <span>Adding {Math.min(photoImportProgress.completed + 1, photoImportProgress.total)} of {photoImportProgress.total}…</span>
      <i aria-hidden="true"><b style={{ width: `${photoImportProgress.total > 0
        ? (photoImportProgress.completed / photoImportProgress.total) * 100 : 0}%` }} /></i>
    </div>
  ) : photoImportMessage ? (
    <p className="people-timeline__import-status" role="status" data-error={photoImportError ? 'true' : 'false'}>{photoImportMessage}</p>
  ) : null

  if (personAlbumOpen) {
    if (!cacheReady) {
      return (
        <section className={`${rootClassName} people-timeline--scrapbook-route`}>
          <div className="people-timeline__empty" role="status">
            <p>Opening the scrapbook…</p>
          </div>
        </section>
      )
    }

    if (!scrapbookPerson) {
      return (
        <section className={`${rootClassName} people-timeline--scrapbook-route`}>
          <div className="people-timeline__empty">
            <p className="people-timeline__empty-title">This scrapbook is not available</p>
            <p>The family member may have been removed or renamed on this device.</p>
            {onClosePersonAlbum ? (
              <button type="button" onClick={onClosePersonAlbum}>Back to Photo Journal</button>
            ) : null}
          </div>
        </section>
      )
    }

    return (
      <>
      <GalleryScanStatus scan={galleryScan} />
      {photoInput}
      <PersonScrapbookPage
        person={scrapbookPerson}
        photos={scrapbookPhotos}
        cacheNamespace={cacheNamespace}
        dateOverrides={timelineState.dateOverrides}
        onBack={onClosePersonAlbum}
        onAddPhotos={onUploadPhotos ? openPhotoPicker : undefined}
        addingPhotos={photoUploadBusy}
        photoImportStatus={photoImportStatus}
        onManage={onClosePersonAlbum
          ? () => managePersonFromScrapbook(scrapbookPerson.id)
          : undefined}
        renderPhotoActions={(photo) => renderPhotoCorrections(photo, scrapbookPerson.id)}
      />
      </>
    )
  }

  return (
    <section className={rootClassName} aria-labelledby="people-timeline-title">
      <GalleryScanStatus scan={galleryScan} />
      <header className="people-timeline__header">
        <h2 id="people-timeline-title">People</h2>
      </header>

      {photoInput}

      {cacheReady ? (
        <PeopleTimelinePeople
          people={setupPeople}
          previews={personPreviewById}
          enrolledPersonIds={enrolledPersonIds}
          selectedPersonId={selectedPersonId}
          setupComplete={setupComplete}
          addDisabled={personEditorBusy}
          onOpenAlbum={openPersonAlbum}
          onManagePerson={startManagingPerson}
          onAddPerson={openAddPerson}
        />
      ) : null}

      <div className="people-timeline__chips" role="group" aria-label="Choose a person timeline">
        <button
          type="button"
          className="people-timeline__chip"
          aria-pressed={selectedPersonId === FAMILY_PERSON_ID}
          onClick={() => choosePerson(FAMILY_PERSON_ID)}
        >
          Family
        </button>
        <button
          type="button"
          className="people-timeline__chip"
          aria-pressed={selectedPersonId === REVIEW_PERSON_ID}
          onClick={() => choosePerson(REVIEW_PERSON_ID)}
        >
          All photos
        </button>
        {actionableReviewMatches.length ? (
          <button
            type="button"
            className="people-timeline__chip people-timeline__review-chip"
            aria-pressed={selectedPersonId === FACE_REVIEW_PERSON_ID}
            aria-label={`Review ${actionableReviewMatches.length} possible ${actionableReviewMatches.length === 1 ? 'match' : 'matches'} (optional)`}
            onClick={() => choosePerson(FACE_REVIEW_PERSON_ID)}
          >
            Review <span>{actionableReviewMatches.length}</span>
          </button>
        ) : null}
        {onUploadPhotos ? (
          <button
            type="button"
            className="people-timeline__upload-button"
            disabled={photoUploadBusy}
            onClick={openPhotoPicker}
          >
            <span aria-hidden="true">＋</span>
            {importingPhotos ? 'Adding…' : 'Add photos'}
          </button>
        ) : null}
        {selectedPerson ? (
          <button
            type="button"
            className="people-timeline__manage-button"
            onClick={() => startManagingPerson()}
            aria-label={`Rename or remove ${selectedPerson.name}`}
          >
            Manage
          </button>
        ) : null}
      </div>

      {cacheReady ? (
        <PeopleTimelineAlbums
          albums={faceMatchedAlbums}
          expanded={showAllFaceMatchedAlbums}
          id={faceMatchedAlbumsId}
          hasPeople={setupPeople.length > 0}
          onExpand={() => setShowAllFaceMatchedAlbums(true)}
          onOpenAlbum={openPersonAlbum}
          onShowAllPhotos={() => choosePerson(REVIEW_PERSON_ID)}
          onAddPerson={openAddPerson}
        />
      ) : null}

      {!managingPerson ? photoImportStatus : null}

      {addingPerson ? (
        <PeopleTimelinePersonForm
          formRef={addPersonFormRef}
          name={newPersonName}
          disabled={addingPersonBusy || importingPhotos}
          scanning={addingPersonBusy}
          error={addPersonError}
          onNameChange={(name) => {
            setNewPersonName(name)
            setAddPersonError('')
          }}
          onPortraitsChange={(files) => {
            setNewPersonPortraits(files.slice(0, MAX_REFERENCE_PHOTOS_AT_ONCE))
            setAddPersonError('')
          }}
          onSubmit={(event) => void addPerson(event)}
          onCancel={closeAddPerson}
        />
      ) : null}

      {managingPerson && selectedPerson ? (
        <PeopleTimelinePersonManager
          personName={selectedPerson.name}
          name={renameDraft}
          referenceCount={timelineState.faceProfiles[selectedPerson.id]?.references.length ?? 0}
          selectedPortraitCount={referencePortraits.length}
          scanning={referenceBusy}
          referenceDisabled={referenceBusy || importingPhotos}
          error={manageError}
          confirmingDelete={confirmingDelete}
          onNameChange={(name) => {
            setRenameDraft(name)
            setManageError('')
          }}
          onPortraitsChange={(files) => {
            setReferencePortraits(files.slice(0, MAX_REFERENCE_PHOTOS_AT_ONCE))
            setManageError('')
          }}
          onRename={renamePerson}
          onSavePortraits={(event) => void saveReferencePortrait(event)}
          onDelete={deleteSelectedPerson}
          onConfirmDelete={setConfirmingDelete}
          onDone={() => setManagingPerson(false)}
          onAddPhotos={onUploadPhotos ? openPhotoPicker : undefined}
          addingPhotos={photoUploadBusy}
          photoImportStatus={photoImportStatus}
        />
      ) : null}

      {cacheReady && faceReviewPreviews.length ? (
        <section className="people-timeline__faces-to-name" aria-label="Possible matches">
          <header>
            <div>
              <h3>Possible matches</h3>
              <p>{actionableReviewMatches.length} possible {actionableReviewMatches.length === 1 ? 'match' : 'matches'} · optional</p>
            </div>
            <button type="button" onClick={() => choosePerson(FACE_REVIEW_PERSON_ID)}>
              Open review
            </button>
          </header>
          <div className="people-timeline__face-candidates">
            {faceReviewPreviews.map((preview) => (
              <button
                key={faceReviewKey(preview.match)}
                type="button"
                aria-label={`Review face suggested as ${preview.person.name}`}
                onClick={() => openFaceReview(preview)}
              >
                <span style={{
                  '--face-x': `${preview.faceCenter[0] * 100}%`,
                  '--face-y': `${preview.faceCenter[1] * 100}%`,
                  '--face-scale': preview.faceScale,
                } as CSSProperties}>
                  <TimelinePhotoImage source={preview.photo.source} alt="" />
                </span>
                <strong>{preview.person.name}</strong>
                <small>Possible match</small>
              </button>
            ))}
          </div>
          <p className="people-timeline__face-hint">
            Strong matches are added automatically, and you can correct them. Other photos stay in All photos.
          </p>
        </section>
      ) : null}

      {!cacheReady ? (
        <div className="people-timeline__empty" role="status">
          <p>Opening your people timeline…</p>
        </div>
      ) : displayedPhoto ? (
        <PeopleTimelineViewer
          photo={displayedPhoto}
          layout={isNamedPersonAlbum ? 'scrapbook' : isFaceReview ? 'review' : 'album'}
          personId={selectedPersonId}
          personName={personName}
          dateOverride={timelineState.dateOverrides[displayedPhoto.key]}
          position={{ index: activeIndex, total: visiblePhotos.length }}
          review={displayedReviewMatch ? {
            match: displayedReviewMatch,
            face: displayedReviewFace,
            person: displayedReviewPerson,
          } : undefined}
          photoLinkRef={photoLinkRef}
          photoFigureRef={photoFigureRef}
          onReview={reviewFaceMatch}
          onPositionChange={(index) => {
            const photo = visiblePhotos[index]
            if (photo) {
              restoredFocusSignature.current = focusRequestSignature
              restoredLinkFocusSignature.current = focusRequestSignature
              setActivePhotoKey(photo.key)
            }
          }}
          onEditDate={beginDateEdit}
        >
          {renderPhotoCorrections(displayedPhoto, selectedPerson?.id)}
          {dateEditorOpen ? (
            <PeopleTimelineDateEditor
              draft={dateDraft}
              error={dateError}
              hasOverride={Boolean(timelineState.dateOverrides[displayedPhoto.key])}
              onPrecisionChange={changeDatePrecision}
              onValueChange={(value) => {
                setDateDraft((current) => ({ ...current, value }))
                setDateError('')
              }}
              onSave={saveDate}
              onCancel={() => setDateEditorOpen(false)}
              onRestoreOriginal={restoreCapturedDate}
            />
          ) : null}
          {displayedPhoto.kind === 'journal-photo' && onDeletePhoto &&
            journalPhotos.some((photo) => photo.id === displayedPhoto.id && photo.ownedByCurrentUser && photo.origin !== 'device-gallery') ? (
            <JournalPhotoDeleteControl
              key={`${cacheNamespace}:${displayedPhoto.id}`}
              photoId={displayedPhoto.id}
              shared={!cacheNamespace.endsWith(':no-family')}
              onDelete={onDeletePhoto}
            />
          ) : <ContentRemovalControl compact
            key={`${cacheNamespace}:${displayedPhoto.kind}:${displayedPhoto.id}`}
            noun="photo"
            hideOnly={!(displayedPhoto.kind === 'capsule-photo' && onDeleteCapsulePhoto && photos.some((photo) =>
              photo.id === displayedPhoto.id && photo.capsuleId === displayedPhoto.capsuleId && photo.ownedByCurrentUser))}
            description={displayedPhoto.kind === 'capsule-photo' && onDeleteCapsulePhoto && photos.some((photo) =>
              photo.id === displayedPhoto.id && photo.capsuleId === displayedPhoto.capsuleId && photo.ownedByCurrentUser)
              ? 'This deletes your photo from this Capsule, its family recap, and its Journal entry for everyone. Separate uploads and videos already saved to a phone stay unchanged.'
              : displayedPhoto.origin === 'device-gallery'
                ? 'This hides the linked photo from Journal on this device. The original stays in your phone gallery. You can restore hidden items below.'
                : 'This hides the photo from your Journal and widget on this device. Your family keeps the original. You can restore hidden items below.'}
            onRemove={async () => {
              if (displayedPhoto.kind === 'capsule-photo' && onDeleteCapsulePhoto && photos.some((photo) =>
                photo.id === displayedPhoto.id && photo.capsuleId === displayedPhoto.capsuleId && photo.ownedByCurrentUser)) {
                await onDeleteCapsulePhoto(displayedPhoto.capsuleId, displayedPhoto.id)
              } else setContentHidden(cacheNamespace, photoVisibilityKey(displayedPhoto.id, displayedPhoto.kind), true)
            }}
          />}
          <PeopleTimelinePhotoTags
            photoKey={displayedPhoto.key}
            people={timelineState.people}
            assignments={timelineState.assignments}
            effectivePersonIds={effectivePeopleByPhoto.get(displayedPhoto.key)}
            open={tagEditorOpen}
            onToggle={() => setTagEditorOpen((current) => !current)}
            onTagChange={(personId, tagged) => setPhotoPersonTag(displayedPhoto.key, personId, tagged)}
          />
        </PeopleTimelineViewer>
      ) : selectedPerson ? (
        <div className="people-timeline__empty">
          <p className="people-timeline__empty-title">
            {timelineState.faceProfiles[selectedPerson.id]?.references.length
              ? `No matches for ${selectedPerson.name} yet`
              : `Add a face photo for ${selectedPerson.name}`}
          </p>
          <p>
            {timelineState.faceProfiles[selectedPerson.id]?.references.length
              ? scanProgress
                ? 'New uploads are being checked on this device.'
                : 'Future uploads will appear here automatically. You can also correct any photo from All photos.'
              : 'A clear portrait lets Bubble recognize this person locally. The portrait itself is never stored.'}
          </p>
          {timelineState.faceProfiles[selectedPerson.id]?.references.length && onUploadPhotos ? (
            <button type="button" disabled={photoUploadBusy} onClick={openPhotoPicker}>
              {importingPhotos ? 'Adding…' : 'Add photos'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => timelineState.faceProfiles[selectedPerson.id]?.references.length
                ? choosePerson(REVIEW_PERSON_ID)
                : startManagingPerson()}
            >
              {timelineState.faceProfiles[selectedPerson.id]?.references.length ? 'All photos' : 'Add face photo'}
            </button>
          )}
        </div>
      ) : selectedPersonId === FACE_REVIEW_PERSON_ID ? (
        <div className="people-timeline__empty">
          <p className="people-timeline__empty-title">Nothing to review</p>
          <p>Strong matches were added automatically. You can correct a person label without removing the photo.</p>
          <button type="button" onClick={() => choosePerson(REVIEW_PERSON_ID)}>All photos</button>
        </div>
      ) : selectedPersonId === REVIEW_PERSON_ID ? (
        <div className="people-timeline__empty">
          <p className="people-timeline__empty-title">Add your family photos</p>
          <p>Choose one photo or a whole batch. They will be saved here immediately and organized automatically after you add family faces.</p>
          {onUploadPhotos ? (
            <button type="button" disabled={photoUploadBusy} onClick={openPhotoPicker}>
              {importingPhotos ? 'Adding…' : 'Add photos'}
            </button>
          ) : null}
        </div>
      ) : !setupComplete ? null : (
        <div className="people-timeline__empty">
          <p className="people-timeline__empty-title">No group photos matched yet</p>
          <p>
            {scanProgress
              ? 'Your ordinary photo uploads are being organized privately on this device.'
              : 'Photos with any two or more family members appear here, matched automatically or confirmed by you.'}
          </p>
          {onUploadPhotos && timelinePhotos.length === 0 ? (
            <button type="button" disabled={photoUploadBusy} onClick={openPhotoPicker}>
              {importingPhotos ? 'Adding…' : 'Add photos'}
            </button>
          ) : timelinePhotos.length ? (
            <button type="button" onClick={() => choosePerson(REVIEW_PERSON_ID)}>All photos</button>
          ) : null}
        </div>
      )}

      {hidden.length > 0 ? <button type="button" className="ks-secondary-button"
        onClick={() => restoreHiddenContent(cacheNamespace)}>Restore hidden items ({hidden.length})</button> : null}
      <PeopleTimelineScanStatus
        progress={scanProgress}
        hasPendingPhotos={Boolean(pendingScanKey)}
        scanDisabled={photoPickerBusy || !pendingScanKey || enrolledPersonIds.size === 0}
        clearDisabled={photoPickerBusy || !hasFaceData}
        clearing={faceDataClearing}
        confirmingClear={confirmingClearFaceData}
        message={scanMessage}
        error={scanError}
        onScan={() => void scanPhotos()}
        onCancelScan={cancelFaceScan}
        onToggleClear={() => setConfirmingClearFaceData((current) => !current)}
        onClear={() => void clearFaceData()}
        onKeep={() => setConfirmingClearFaceData(false)}
      />
    </section>
  )
}
