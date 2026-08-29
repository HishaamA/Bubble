import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
} from 'react'
import { Link } from 'react-router-dom'
import { TimelinePhotoImage } from './TimelinePhotoImage'
import { PersonScrapbookPage } from './PersonScrapbookPage'
import { scanReferencePortrait, scanTimelineFaces } from './faceRecognition'
import {
  createFaceReviewCandidates,
  createFaceSuggestions,
  effectivePeopleForPhoto,
  formatTimelinePhotoDate,
  migrateLegacyPeopleTimelineState,
  sortTimelinePhotos,
  toPeopleTimelinePhotos,
} from './peopleTimelineHelpers'
import {
  emptyPeopleTimelineState,
  loadPeopleTimelineState,
  savePeopleTimelineState,
} from './peopleTimelineStore'
import { removePersonScrapbookProfile } from './personScrapbookStore'
import {
  FACE_SCAN_REVISION,
  FAMILY_PERSON_ID,
  type FaceSuggestion,
  type PeopleTimelinePhoto,
  type PeopleTimelineProps,
  type PeopleTimelineState,
  type TimelineDatePrecision,
} from './types'
import './PeopleTimeline.css'

const REVIEW_PERSON_ID = 'review-uploads'
const FACE_REVIEW_PERSON_ID = 'review-face-matches'
const MAX_REFERENCE_PHOTO_BYTES = 25 * 1024 * 1024
const MAX_REFERENCE_PHOTOS_AT_ONCE = 5
const MAX_FACE_REFERENCES_PER_PERSON = 12

type DateDraft = {
  precision: TimelineDatePrecision
  value: string
}

type ScanProgress = {
  completed: number
  total: number
  saved: number
}

type FaceReviewPreview = {
  match: FaceSuggestion
  photo: PeopleTimelinePhoto
  person: PeopleTimelineState['people'][number]
  faceCenter: [x: number, y: number]
  faceScale: number
}

function createLocalId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `person-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function personInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? '')
    .join('') || '?'
}

function localIsoDate(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function stoppedScanMessage(savedPhotoCount: number) {
  return savedPhotoCount > 0
    ? `Scan stopped. Results from ${savedPhotoCount} ${savedPhotoCount === 1 ? 'photo were' : 'photos were'} saved.`
    : 'Scan stopped. No face data was saved.'
}

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

function automaticScanSignature(
  faceProfiles: PeopleTimelineState['faceProfiles'],
  faceScans: PeopleTimelineState['faceScans'],
  photos: readonly PeopleTimelinePhoto[],
) {
  const profileSignature = Object.entries(faceProfiles)
    .filter(([, profile]) => profile.references.length > 0)
    .map(([personId, profile]) => `${personId}:${profile.references.length}`)
    .sort()
  if (!profileSignature.length) return ''
  const pendingPhotoKeys = photos
    .filter((photo) => photo.canScanFaces && faceScans[photo.key] === undefined)
    .map((photo) => typeof photo.scanSource === 'string'
      ? `${photo.key}\u0002${photo.scanSource}`
      : photo.key)
    .sort()
  if (!pendingPhotoKeys.length) return ''
  return `${FACE_SCAN_REVISION}\u0003${profileSignature.join('\u0000')}\u0001${pendingPhotoKeys.join('\u0000')}`
}

function faceReviewKey(suggestion: FaceSuggestion) {
  return `${suggestion.photoKey}\u0000${suggestion.faceId}\u0000${suggestion.personId}`
}

async function scanReferencePhotos(files: readonly File[]) {
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

function originalDateDraft(photo: PeopleTimelinePhoto): DateDraft {
  const capturedDate = new Date(photo.capturedAt)
  if (!Number.isFinite(capturedDate.getTime())) {
    return { precision: 'year', value: String(new Date().getFullYear()) }
  }
  return { precision: 'day', value: localIsoDate(capturedDate) }
}

function photoDestination(photo: PeopleTimelinePhoto) {
  if (photo.kind === 'journal-photo') {
    return `/journal/library/${encodeURIComponent(photo.id)}`
  }
  return `/journal/photo/${encodeURIComponent(photo.capsuleId)}/${encodeURIComponent(photo.id)}`
}

function photoRouteState(photo: PeopleTimelinePhoto, personId: string) {
  return {
    returnTo: '/journal',
    sourceMemoryId: photo.id,
    journalContext: {
      section: 'people',
      personId,
      focusMemoryId: photo.memoryId,
    },
  }
}

export function PeopleTimeline({
  photos,
  journalPhotos = [],
  cacheNamespace,
  className,
  initialPersonId,
  focusMemoryId,
  onUploadPhotos,
  photoImportProgress,
  personAlbumOpen = false,
  onOpenPersonAlbum,
  onClosePersonAlbum,
}: PeopleTimelineProps) {
  const [timelineState, setTimelineState] = useState(emptyPeopleTimelineState)
  const [cacheReady, setCacheReady] = useState(false)
  const [selectedPersonId, setSelectedPersonId] = useState(FAMILY_PERSON_ID)
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
  const [postponedFaceReviews, setPostponedFaceReviews] = useState<string[]>([])
  const saveQueue = useRef(Promise.resolve())
  const scanController = useRef<AbortController | null>(null)
  const scanSavedPhotoCount = useRef(0)
  const timelineStateRef = useRef(timelineState)
  const photoLinkRef = useRef<HTMLAnchorElement>(null)
  const photoFigureRef = useRef<HTMLElement>(null)
  const restoredPersonSignature = useRef('')
  const restoredFocusSignature = useRef('')
  const restoredLinkFocusSignature = useRef('')
  const lastAutomaticScanSignature = useRef('')
  const photoInputRef = useRef<HTMLInputElement>(null)
  const importingPhotos = photoImportProgress?.importing ?? false
  const photoPickerBusy = importingPhotos ||
    Boolean(scanProgress) ||
    addingPersonBusy ||
    referenceBusy ||
    faceDataClearing

  const timelinePhotos = useMemo(
    () => toPeopleTimelinePhotos(photos, journalPhotos),
    [journalPhotos, photos],
  )
  const selectedPerson = timelineState.people.find(
    ({ id }) => id === selectedPersonId,
  )
  const personName = selectedPerson?.name ?? (
    selectedPersonId === REVIEW_PERSON_ID
      ? 'All photos'
      : selectedPersonId === FACE_REVIEW_PERSON_ID
        ? 'Review matches'
        : 'Family'
  )
  const automaticMatches = useMemo(
    () => createFaceSuggestions(timelineState),
    [timelineState],
  )
  const reviewMatches = useMemo(
    () => createFaceReviewCandidates(timelineState),
    [timelineState],
  )
  const actionableReviewMatches = useMemo(() => {
    const postponed = new Set(postponedFaceReviews)
    return reviewMatches.filter((match) => !postponed.has(faceReviewKey(match)))
  }, [postponedFaceReviews, reviewMatches])
  const faceReviewPreviews = useMemo(() => {
    const previews: FaceReviewPreview[] = []
    const usedPhotos = new Set<string>()
    for (const match of actionableReviewMatches) {
      if (usedPhotos.has(match.photoKey)) continue
      const photo = timelinePhotos.find(({ key }) => key === match.photoKey)
      const person = timelineState.people.find(({ id }) => id === match.personId)
      const face = timelineState.faceScans[match.photoKey]?.faces.find(
        ({ id }) => id === match.faceId,
      )
      if (!photo || !person || !face) continue
      usedPhotos.add(match.photoKey)
      previews.push({
        match,
        photo,
        person,
        faceCenter: [
          face.box[0] + face.box[2] / 2,
          face.box[1] + face.box[3] / 2,
        ],
        faceScale: Math.min(
          2.8,
          Math.max(1.25, 0.7 / Math.max(face.box[2], face.box[3])),
        ),
      })
      if (previews.length === 3) break
    }
    return previews
  }, [
    actionableReviewMatches,
    timelinePhotos,
    timelineState.faceScans,
    timelineState.people,
  ])
  const effectivePeopleByPhoto = useMemo(() => new Map(
    timelinePhotos.map((photo) => [
      photo.key,
      new Set(effectivePeopleForPhoto(timelineState, photo.key, automaticMatches)),
    ]),
  ), [automaticMatches, timelinePhotos, timelineState])
  const enrolledPersonIds = useMemo(
    () => new Set(Object.entries(timelineState.faceProfiles)
      .filter(([, profile]) => profile.references.length > 0)
      .map(([personId]) => personId)),
    [timelineState.faceProfiles],
  )
  const setupComplete = enrolledPersonIds.size >= 2
  const setupPeople = useMemo(() => [...timelineState.people]
    .sort((first, second) => (
      Number(enrolledPersonIds.has(second.id)) - Number(enrolledPersonIds.has(first.id))
    )), [enrolledPersonIds, timelineState.people])
  const emptySetupSlotCount = Math.max(1, 3 - setupPeople.length)
  const personPreviewById = useMemo(() => {
    const previews = new Map<string, PeopleTimelinePhoto>()
    for (const person of timelineState.people) {
      const photo = timelinePhotos.find(({ key }) =>
        effectivePeopleByPhoto.get(key)?.has(person.id),
      )
      if (photo) previews.set(person.id, photo)
    }
    return previews
  }, [effectivePeopleByPhoto, timelinePhotos, timelineState.people])
  const faceMatchedAlbums = useMemo(() => timelineState.people.flatMap((person) => {
    const matchingPhotos = timelinePhotos.filter(({ key }) =>
      effectivePeopleByPhoto.get(key)?.has(person.id),
    )
    const preview = matchingPhotos[0]
    return preview
      ? [{ person, preview, photoCount: matchingPhotos.length }]
      : []
  }), [effectivePeopleByPhoto, timelinePhotos, timelineState.people])
  const familyPhotoKeys = useMemo(() => new Set(
    timelinePhotos
      .filter((photo) => {
        const effectivePeople = effectivePeopleByPhoto.get(photo.key)
        if (!effectivePeople) return false
        let enrolledCount = 0
        for (const personId of effectivePeople) {
          if (enrolledPersonIds.has(personId)) enrolledCount += 1
          if (enrolledCount >= 2) return true
        }
        return false
      })
      .map(({ key }) => key),
  ), [effectivePeopleByPhoto, enrolledPersonIds, timelinePhotos])
  const visiblePhotos = useMemo(() => {
    const reviewPhotoKeys = selectedPersonId === FACE_REVIEW_PERSON_ID
      ? new Set(actionableReviewMatches.map(({ photoKey }) => photoKey))
      : null
    const relevantPhotos = selectedPersonId === REVIEW_PERSON_ID
      ? timelinePhotos
      : selectedPersonId === FACE_REVIEW_PERSON_ID
        ? timelinePhotos.filter(({ key }) => reviewPhotoKeys?.has(key))
      : selectedPersonId === FAMILY_PERSON_ID
        ? timelinePhotos.filter(({ key }) => familyPhotoKeys.has(key))
        : timelinePhotos.filter((photo) =>
          effectivePeopleByPhoto.get(photo.key)?.has(selectedPersonId),
        )
    return sortTimelinePhotos(relevantPhotos, timelineState.dateOverrides)
  }, [actionableReviewMatches, effectivePeopleByPhoto, familyPhotoKeys, selectedPersonId, timelinePhotos, timelineState.dateOverrides])
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

  const replaceTimelineState = useCallback((nextState: typeof timelineState) => {
    timelineStateRef.current = nextState
    setTimelineState(nextState)
    return nextState
  }, [])

  const updateTimelineState = useCallback((
    update: (current: typeof timelineState) => typeof timelineState,
  ) => {
    return replaceTimelineState(update(timelineStateRef.current))
  }, [replaceTimelineState])

  const queueTimelineStateSave = useCallback((state: typeof timelineState) => {
    const result = saveQueue.current
      .catch(() => undefined)
      .then(() => savePeopleTimelineState(cacheNamespace, state))
      .catch(() => false)
    saveQueue.current = result.then(() => undefined)
    return result
  }, [cacheNamespace])

  useEffect(() => {
    let active = true
    scanController.current?.abort()
    scanController.current = null
    setScanProgress(null)
    setCacheReady(false)
    replaceTimelineState(emptyPeopleTimelineState())
    setSelectedPersonId(FAMILY_PERSON_ID)
    setActivePhotoKey(null)
    setPostponedFaceReviews([])
    restoredPersonSignature.current = ''
    restoredFocusSignature.current = ''
    restoredLinkFocusSignature.current = ''
    lastAutomaticScanSignature.current = ''
    void loadPeopleTimelineState(cacheNamespace).then((storedState) => {
      if (!active) return
      replaceTimelineState(storedState)
      setCacheReady(true)
    })
    return () => {
      active = false
    }
  }, [cacheNamespace, replaceTimelineState])

  useEffect(() => {
    if (!cacheReady) return
    const migratedState = migrateLegacyPeopleTimelineState(
      timelineStateRef.current,
      timelinePhotos,
    )
    if (migratedState !== timelineStateRef.current) {
      replaceTimelineState(migratedState)
    }
  }, [cacheReady, replaceTimelineState, timelinePhotos])

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
      setSelectedPersonId(FAMILY_PERSON_ID)
    }
  }, [selectedPersonId, timelineState.people])

  useEffect(() => {
    if (!visiblePhotos.length) {
      setActivePhotoKey(null)
      return
    }
    if (!visiblePhotos.some(({ key }) => key === activePhotoKey)) {
      setActivePhotoKey(visiblePhotos[0]?.key ?? null)
    }
  }, [activePhotoKey, visiblePhotos])

  useEffect(() => {
    if (!cacheReady) return
    const requestedPersonId = initialPersonId ?? FAMILY_PERSON_ID
    const personSignature = `${cacheNamespace}\u0000${requestedPersonId}`
    const restoredPersonId = requestedPersonId === FAMILY_PERSON_ID ||
      requestedPersonId === REVIEW_PERSON_ID ||
      requestedPersonId === FACE_REVIEW_PERSON_ID ||
      timelineState.people.some(({ id }) => id === requestedPersonId)
      ? requestedPersonId
      : FAMILY_PERSON_ID
    if (restoredPersonSignature.current !== personSignature) {
      restoredPersonSignature.current = personSignature
      if (selectedPersonId !== restoredPersonId) {
        setSelectedPersonId(restoredPersonId)
        setActivePhotoKey(null)
      }
    }

    if (!focusMemoryId) return
    const focusSignature = `${cacheNamespace}\u0000${restoredPersonId}\u0000${focusMemoryId}`
    if (restoredFocusSignature.current === focusSignature) return
    const focusedPhoto = timelinePhotos.find(({ memoryId }) => memoryId === focusMemoryId)
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
    initialPersonId,
    selectedPersonId,
    timelinePhotos,
    timelineState.people,
  ])

  useEffect(() => {
    if (!focusMemoryId || !displayedPhoto) return
    const focusSignature = `${cacheNamespace}\u0000${selectedPersonId}\u0000${focusMemoryId}`
    if (
      restoredFocusSignature.current !== focusSignature ||
      restoredLinkFocusSignature.current === focusSignature ||
      displayedPhoto.memoryId !== focusMemoryId
    ) return

    const frame = window.requestAnimationFrame(() => {
      restoredLinkFocusSignature.current = focusSignature
      const photoSurface = photoLinkRef.current ?? photoFigureRef.current
      photoSurface?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [cacheNamespace, displayedPhoto, focusMemoryId, selectedPersonId])

  useEffect(() => {
    setTagEditorOpen(false)
    setDateEditorOpen(false)
    setDateError('')
  }, [displayedPhoto?.key])

  useEffect(() => () => scanController.current?.abort(), [])

  function choosePerson(personId: string) {
    setSelectedPersonId(personId)
    setActivePhotoKey(null)
    setManagingPerson(false)
    setConfirmingDelete(false)
    setReferencePortraits([])
    setManageError('')
  }

  function openPersonAlbum(personId: string) {
    if (onOpenPersonAlbum) {
      onOpenPersonAlbum(personId)
      return
    }
    choosePerson(personId)
  }

  function openAddPerson() {
    if (photoPickerBusy) return
    setAddingPerson(true)
    setAddPersonError('')
    setNewPersonPortraits([])
    setManagingPerson(false)
  }

  function openPhotoPicker() {
    if (photoPickerBusy) return
    photoInputRef.current?.click()
  }

  async function addJournalPhotos(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length || !onUploadPhotos || photoPickerBusy) return

    choosePerson(REVIEW_PERSON_ID)
    setPhotoImportError(false)
    setPhotoImportMessage(
      `Adding ${files.length} ${files.length === 1 ? 'photo' : 'photos'}…`,
    )
    try {
      const result = await onUploadPhotos(files)
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
      setPhotoImportError(true)
      setPhotoImportMessage(
        'Those photos could not be saved on this device. Check free storage and try again.',
      )
    }
  }

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
    if (scanController.current) {
      setAddPersonError('Wait for the current photo check to finish, then try again.')
      return
    }

    setAddingPersonBusy(true)
    setAddPersonError('')
    try {
      const { scans, failed } = await scanReferencePhotos(newPersonPortraits)
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
      setAddingPersonBusy(false)
    }
  }

  function startManagingPerson(
    person: PeopleTimelineState['people'][number] | undefined = selectedPerson,
  ) {
    if (!person) return
    setSelectedPersonId(person.id)
    setActivePhotoKey(null)
    setAddingPerson(false)
    setRenameDraft(person.name)
    setManageError('')
    setReferencePortraits([])
    setConfirmingDelete(false)
    setManagingPerson(true)
  }

  function openFaceReview(preview: FaceReviewPreview) {
    choosePerson(FACE_REVIEW_PERSON_ID)
    setActivePhotoKey(preview.photo.key)
  }

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

  async function saveReferencePortrait(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedPerson) return
    const form = event.currentTarget
    const portraitError = referencePhotoError(referencePortraits)
    if (portraitError) {
      setManageError(portraitError)
      return
    }
    if (scanController.current) {
      setManageError('Wait for the current photo check to finish, then try again.')
      return
    }

    const personId = selectedPerson.id
    const personLabel = selectedPerson.name
    setReferenceBusy(true)
    setManageError('')
    try {
      const { scans, failed } = await scanReferencePhotos(referencePortraits)
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
      setReferenceBusy(false)
    }
  }

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

  function setPhotoTag(personId: string, tagged: boolean) {
    if (!displayedPhoto) return
    const automaticallyMatched = automaticMatches.some((match) =>
      match.photoKey === displayedPhoto.key && match.personId === personId,
    ) || timelineState.assignments.some((assignment) =>
      assignment.photoKey === displayedPhoto.key &&
      assignment.personId === personId &&
      assignment.source === 'face-suggestion',
    )
    updateTimelineState((current) => {
      const withoutTag = current.assignments.filter((assignment) => !(
        assignment.photoKey === displayedPhoto.key && assignment.personId === personId
      ))
      const withoutDismissal = current.dismissedSuggestions.filter((dismissal) => !(
        dismissal.photoKey === displayedPhoto.key && dismissal.personId === personId
      ))
      return {
        ...current,
        assignments: tagged
          ? [...withoutTag, {
              photoKey: displayedPhoto.key,
              personId,
              source: 'manual',
              confirmedAt: new Date().toISOString(),
            }]
          : withoutTag,
        dismissedSuggestions: !tagged && automaticallyMatched
          ? [...withoutDismissal, {
              photoKey: displayedPhoto.key,
              personId,
              dismissedAt: new Date().toISOString(),
            }]
          : withoutDismissal,
      }
    })
  }

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

  function beginDateEdit() {
    if (!displayedPhoto) return
    setDateDraft(
      timelineState.dateOverrides[displayedPhoto.key] ?? originalDateDraft(displayedPhoto),
    )
    setDateError('')
    setDateEditorOpen(true)
  }

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

  function restoreCapturedDate() {
    if (!displayedPhoto) return
    updateTimelineState((current) => {
      const dateOverrides = { ...current.dateOverrides }
      delete dateOverrides[displayedPhoto.key]
      return { ...current, dateOverrides }
    })
    setDateEditorOpen(false)
  }

  const scanPhotos = useCallback(async (automatic = false) => {
    if (scanController.current || scanProgress) return
    if (!Object.keys(timelineStateRef.current.faceProfiles).length) {
      if (!automatic) setScanMessage('Add a face photo for someone before checking uploads.')
      return
    }
    const unscannedPhotos = timelinePhotos.filter((photo) =>
      photo.canScanFaces && timelineStateRef.current.faceScans[photo.key] === undefined,
    )
    setScanError(false)
    if (!unscannedPhotos.length) {
      if (!automatic) setScanMessage('Face matching is up to date.')
      return
    }

    const controller = new AbortController()
    scanController.current = controller
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
      lastAutomaticScanSignature.current = automaticScanSignature(
        timelineStateRef.current.faceProfiles,
        timelineStateRef.current.faceScans,
        timelinePhotos,
      )
      if (!controller.signal.aborted) setScanProgress(null)
      if (scanController.current === controller) scanController.current = null
    }
  }, [queueTimelineStateSave, scanProgress, timelinePhotos, updateTimelineState])

  function cancelFaceScan() {
    const savedPhotoCount = scanSavedPhotoCount.current
    scanController.current?.abort()
    scanController.current = null
    lastAutomaticScanSignature.current = automaticScanSignature(
      timelineStateRef.current.faceProfiles,
      timelineStateRef.current.faceScans,
      timelinePhotos,
    )
    setScanProgress(null)
    setScanError(false)
    setScanMessage(stoppedScanMessage(savedPhotoCount))
  }

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
      referenceBusy ||
      faceDataClearing ||
      lastAutomaticScanSignature.current === pendingScanKey
    ) return

    lastAutomaticScanSignature.current = pendingScanKey
    void scanPhotos(true)
  }, [
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
      <PersonScrapbookPage
        person={scrapbookPerson}
        photos={scrapbookPhotos}
        cacheNamespace={cacheNamespace}
        dateOverrides={timelineState.dateOverrides}
        onBack={onClosePersonAlbum}
      />
    )
  }

  return (
    <section className={rootClassName} aria-labelledby="people-timeline-title">
      <header className="people-timeline__header">
        <h2 id="people-timeline-title">People</h2>
      </header>

      {onUploadPhotos ? (
        <input
          ref={photoInputRef}
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-testid="family-photo-input"
          type="file"
          accept="image/*"
          multiple
          disabled={photoPickerBusy}
          onChange={(event) => void addJournalPhotos(event)}
        />
      ) : null}

      {cacheReady ? (
        <section
          className="people-timeline__setup"
          aria-label={setupComplete ? 'Family people' : undefined}
          aria-labelledby={setupComplete ? undefined : 'people-setup-title'}
        >
          <div
            className="people-timeline__setup-slots"
            role="group"
            aria-label="Family face setup"
          >
            {setupPeople.map((person) => {
              const preview = person ? personPreviewById.get(person.id) : undefined
              const ready = enrolledPersonIds.has(person.id)
              const hasAlbum = Boolean(preview)
              return (
                <button
                  key={person.id}
                  type="button"
                  className="people-timeline__setup-person"
                  data-ready={ready ? 'true' : 'false'}
                  data-needs-face={ready ? 'false' : 'true'}
                  aria-label={ready || hasAlbum ? person.name : `${person.name}, face photo needed`}
                  aria-pressed={selectedPersonId === person.id}
                  onClick={() => ready || hasAlbum
                    ? openPersonAlbum(person.id)
                    : startManagingPerson(person)}
                >
                  <span className="people-timeline__setup-circle">
                    {preview ? (
                      <TimelinePhotoImage source={preview.source} alt="" />
                    ) : (
                      <span className="people-timeline__initials" aria-hidden="true">
                        {personInitials(person.name)}
                      </span>
                    )}
                  </span>
                  <strong>{person.name}</strong>
                </button>
              )
            })}

            {Array.from({ length: emptySetupSlotCount }, (_, slotIndex) => {
              const slotIsAvailable = slotIndex === 0
              const label = slotIsAvailable
                ? 'Add person'
                : `Empty family slot ${slotIndex}`
              return (
                <button
                  key={`setup-slot-${slotIndex}`}
                  type="button"
                  className={`people-timeline__setup-person people-timeline__setup-person--empty ${
                    slotIsAvailable
                      ? 'people-timeline__setup-person--add'
                      : 'people-timeline__setup-person--placeholder'
                  }`}
                  aria-label={label}
                  disabled={!slotIsAvailable || photoPickerBusy}
                  onClick={openAddPerson}
                >
                  <span className="people-timeline__setup-circle" aria-hidden="true">
                    {slotIsAvailable ? '＋' : ''}
                  </span>
                  {slotIsAvailable ? <strong>Add person</strong> : null}
                </button>
              )
            })}
          </div>

          {!setupComplete ? (
            <div className="people-timeline__setup-copy">
              <h3 id="people-setup-title">Create your people</h3>
              <p>Add two family members to start grouping the photos they share.</p>
            </div>
          ) : null}
        </section>
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
            onClick={() => choosePerson(FACE_REVIEW_PERSON_ID)}
          >
            Review <span>{actionableReviewMatches.length}</span>
          </button>
        ) : null}
        {onUploadPhotos ? (
          <button
            type="button"
            className="people-timeline__upload-button"
            disabled={photoPickerBusy}
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
        <section
          className="people-timeline__albums"
          aria-labelledby="people-albums-title"
        >
          <header className="people-timeline__albums-header">
            <div>
              <h3 id="people-albums-title">Face-matched albums</h3>
              <p>
                <span aria-hidden="true">♙</span>
                On-device · private
              </p>
            </div>
            {faceMatchedAlbums.length > 2 ? (
              <button type="button" onClick={() => choosePerson(REVIEW_PERSON_ID)}>
                See all <span aria-hidden="true">›</span>
              </button>
            ) : null}
          </header>

          {faceMatchedAlbums.length ? (
            <div className="people-timeline__album-grid">
              {faceMatchedAlbums.map(({ person, preview, photoCount }, index) => (
                <button
                  key={person.id}
                  type="button"
                  className="people-timeline__album-tile"
                  data-tint={index % 3}
                  aria-label={`Open ${person.name}'s scrapbook, ${photoCount} matched ${photoCount === 1 ? 'photo' : 'photos'}`}
                  onClick={() => openPersonAlbum(person.id)}
                >
                  <span className="people-timeline__album-tile-image">
                    <TimelinePhotoImage
                      source={preview.source}
                      alt=""
                      width={preview.displayWidth}
                      height={preview.displayHeight}
                    />
                  </span>
                  <span className="people-timeline__album-tile-copy">
                    <strong>{person.name}</strong>
                    <small>{photoCount} matched {photoCount === 1 ? 'photo' : 'photos'}</small>
                  </span>
                  <span className="people-timeline__album-tile-doodle" aria-hidden="true">
                    {index % 3 === 0 ? '✦' : index % 3 === 1 ? '⌁' : '♡'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="people-timeline__albums-empty"
              onClick={setupPeople.length ? () => choosePerson(REVIEW_PERSON_ID) : openAddPerson}
            >
              <span aria-hidden="true">✦</span>
              <span>
                <strong>Your first scrapbook starts here</strong>
                <small>{setupPeople.length
                  ? 'Matched family photos will collect here.'
                  : 'Add a person to begin matching photos.'}</small>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          )}
        </section>
      ) : null}

      {importingPhotos && photoImportProgress ? (
        <div
          className="people-timeline__import-progress"
          role="progressbar"
          aria-label="Adding family photos"
          aria-valuemin={0}
          aria-valuemax={photoImportProgress.total}
          aria-valuenow={photoImportProgress.completed}
        >
          <span>
            Adding {Math.min(photoImportProgress.completed + 1, photoImportProgress.total)} of {photoImportProgress.total}…
          </span>
          <i aria-hidden="true">
            <b style={{ width: `${photoImportProgress.total > 0
              ? (photoImportProgress.completed / photoImportProgress.total) * 100
              : 0}%` }} />
          </i>
        </div>
      ) : photoImportMessage ? (
        <p className="people-timeline__import-status" role="status" data-error={photoImportError ? 'true' : 'false'}>
          {photoImportMessage}
        </p>
      ) : null}

      {addingPerson ? (
        <form className="people-timeline__inline-form people-timeline__person-form" aria-label="Add a person" onSubmit={(event) => void addPerson(event)}>
          <label>
            <span>Name</span>
            <input
              autoFocus
              value={newPersonName}
              maxLength={40}
              autoComplete="off"
              disabled={addingPersonBusy || importingPhotos || Boolean(scanProgress)}
              onChange={(event) => {
                setNewPersonName(event.target.value)
                setAddPersonError('')
              }}
            />
          </label>
          <label>
            <span>Face photos</span>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={addingPersonBusy || importingPhotos || Boolean(scanProgress)}
              onChange={(event) => {
                setNewPersonPortraits(Array.from(event.currentTarget.files ?? []).slice(0, MAX_REFERENCE_PHOTOS_AT_ONCE))
                setAddPersonError('')
              }}
            />
            <small>Choose 1–5 clear solo photos. Different ages or slight angles improve matching. The photos are scanned once and never stored.</small>
          </label>
          <div className="people-timeline__form-actions">
            <button type="submit" disabled={addingPersonBusy || importingPhotos || Boolean(scanProgress)}>
              {addingPersonBusy ? 'Scanning…' : 'Add person'}
            </button>
            <button
              type="button"
              disabled={addingPersonBusy}
              onClick={() => {
                setAddingPerson(false)
                setNewPersonPortraits([])
                setAddPersonError('')
              }}
            >
              Cancel
            </button>
          </div>
          {addPersonError ? <p role="alert">{addPersonError}</p> : null}
        </form>
      ) : null}

      {managingPerson && selectedPerson ? (
        <div className="people-timeline__manage-panel">
          <form className="people-timeline__inline-form" aria-label={`Rename ${selectedPerson.name}`} onSubmit={renamePerson}>
            <label>
              <span>Name</span>
              <input
                autoFocus
                value={renameDraft}
                maxLength={40}
                disabled={referenceBusy}
                onChange={(event) => {
                  setRenameDraft(event.target.value)
                  setManageError('')
                }}
              />
            </label>
            <div className="people-timeline__form-actions">
              <button type="submit" disabled={referenceBusy}>Save name</button>
              <button type="button" onClick={() => setManagingPerson(false)}>Done</button>
            </div>
          </form>
          <form
            className="people-timeline__reference-form"
            aria-label={`Add face photos for ${selectedPerson.name}`}
            onSubmit={(event) => void saveReferencePortrait(event)}
          >
            <div>
              <strong>
                {timelineState.faceProfiles[selectedPerson.id]?.references.length
                  ? `${timelineState.faceProfiles[selectedPerson.id]?.references.length} face ${timelineState.faceProfiles[selectedPerson.id]?.references.length === 1 ? 'view' : 'views'} ready`
                  : 'Face photo needed'}
              </strong>
              <span>
                {timelineState.faceProfiles[selectedPerson.id]?.references.length
                  ? 'Add a different age or angle to improve difficult matches.'
                  : `Add one clear portrait to organize ${selectedPerson.name}’s photos automatically.`}
              </span>
            </div>
            <label>
              <span className="people-timeline__sr-only">Face photo for {selectedPerson.name}</span>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={referenceBusy || importingPhotos || Boolean(scanProgress)}
                onChange={(event) => {
                  setReferencePortraits(Array.from(event.currentTarget.files ?? []).slice(0, MAX_REFERENCE_PHOTOS_AT_ONCE))
                  setManageError('')
                }}
              />
            </label>
            <button type="submit" disabled={referenceBusy || importingPhotos || Boolean(scanProgress) || !referencePortraits.length}>
              {referenceBusy
                ? 'Scanning…'
                : timelineState.faceProfiles[selectedPerson.id]?.references.length
                  ? 'Add face views'
                  : 'Add face photo'}
            </button>
          </form>
          {manageError ? <p className="people-timeline__manage-error" role="alert">{manageError}</p> : null}
          {confirmingDelete ? (
            <div className="people-timeline__delete-confirm" role="group" aria-label={`Remove ${selectedPerson.name}`}>
              <p>Remove this person and their photo tags?</p>
              <button type="button" onClick={deleteSelectedPerson}>Remove</button>
              <button type="button" onClick={() => setConfirmingDelete(false)}>Keep</button>
            </div>
          ) : (
            <button type="button" className="people-timeline__delete-button" disabled={referenceBusy} onClick={() => setConfirmingDelete(true)}>
              Remove person
            </button>
          )}
        </div>
      ) : null}

      {cacheReady && faceReviewPreviews.length ? (
        <section className="people-timeline__faces-to-name" aria-label="Faces to name">
          <header>
            <div>
              <h3>Faces to name</h3>
              <p>Check the people Bubble found in your photos.</p>
            </div>
            <button type="button" onClick={() => choosePerson(FACE_REVIEW_PERSON_ID)}>
              Review all
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
                <small>Review face</small>
              </button>
            ))}
          </div>
          <p className="people-timeline__face-hint">
            Reviewing a face helps group future photos more accurately.
          </p>
        </section>
      ) : null}

      {!cacheReady ? (
        <div className="people-timeline__empty" role="status">
          <p>Opening your people timeline…</p>
        </div>
      ) : displayedPhoto ? (
        <div
          className="people-timeline__viewer"
          data-layout={isNamedPersonAlbum ? 'scrapbook' : isFaceReview ? 'review' : 'album'}
        >
          {isFaceReview ? (
            <Link
              ref={photoLinkRef}
              className="people-timeline__photo-link"
              data-face-review={displayedReviewFace ? 'true' : 'false'}
              to={photoDestination(displayedPhoto)}
              state={photoRouteState(displayedPhoto, selectedPersonId)}
              aria-label={`Open ${displayedPhoto.caption}, shared by ${displayedPhoto.contributorName}`}
            >
              <TimelinePhotoImage
                key={displayedPhoto.key}
                source={displayedPhoto.scanSource}
                alt={displayedPhoto.caption}
                width={displayedPhoto.displayWidth}
                height={displayedPhoto.displayHeight}
              />
              {displayedReviewFace ? (
                <span
                  className="people-timeline__face-focus"
                  aria-hidden="true"
                  style={{
                    left: `${displayedReviewFace.box[0] * 100}%`,
                    top: `${displayedReviewFace.box[1] * 100}%`,
                    width: `${displayedReviewFace.box[2] * 100}%`,
                    height: `${displayedReviewFace.box[3] * 100}%`,
                  }}
                />
              ) : null}
            </Link>
          ) : isNamedPersonAlbum ? (
            <figure
              ref={photoFigureRef}
              className="people-timeline__scrapbook-photo"
              tabIndex={-1}
              aria-label={`${displayedPhoto.caption}, shared by ${displayedPhoto.contributorName}`}
            >
              <span className="people-timeline__scrapbook-tape" aria-hidden="true" />
              <span className="people-timeline__scrapbook-doodle" aria-hidden="true">♡</span>
              <span className="people-timeline__scrapbook-image">
                <TimelinePhotoImage
                  key={displayedPhoto.key}
                  source={displayedPhoto.scanSource}
                  alt={displayedPhoto.caption}
                  width={displayedPhoto.displayWidth}
                  height={displayedPhoto.displayHeight}
                />
              </span>
              <figcaption>
                <strong>{displayedPhoto.caption}</strong>
                <span>{formatTimelinePhotoDate(displayedPhoto, timelineState.dateOverrides[displayedPhoto.key])}</span>
              </figcaption>
            </figure>
          ) : (
            <figure
              ref={photoFigureRef}
              className="people-timeline__album-photo"
              tabIndex={-1}
              aria-label={`${displayedPhoto.caption}, shared by ${displayedPhoto.contributorName}`}
            >
              <TimelinePhotoImage
                key={displayedPhoto.key}
                source={displayedPhoto.scanSource}
                alt={displayedPhoto.caption}
                width={displayedPhoto.displayWidth}
                height={displayedPhoto.displayHeight}
              />
            </figure>
          )}

          {displayedReviewMatch && displayedReviewPerson ? (
            <section className="people-timeline__face-review" aria-live="polite">
              <div>
                <span>Quick review</span>
                <strong>Is the outlined face {displayedReviewPerson.name}?</strong>
                <small>Your answer improves future matches only on this device.</small>
              </div>
              <div className="people-timeline__face-review-actions">
                <button type="button" onClick={() => reviewFaceMatch(displayedReviewMatch, 'yes')}>Yes</button>
                <button type="button" onClick={() => reviewFaceMatch(displayedReviewMatch, 'no')}>No</button>
                <button type="button" onClick={() => reviewFaceMatch(displayedReviewMatch, 'unsure')}>Not sure</button>
              </div>
            </section>
          ) : null}

          <div className="people-timeline__timeline-meta" aria-live="polite">
            <div>
              <time dateTime={timelineState.dateOverrides[displayedPhoto.key]?.value ?? displayedPhoto.capturedAt}>
                {formatTimelinePhotoDate(displayedPhoto, timelineState.dateOverrides[displayedPhoto.key])}
              </time>
              <span>{activeIndex + 1} of {visiblePhotos.length}</span>
            </div>
            <button type="button" onClick={beginDateEdit}>Edit date</button>
          </div>

          <label className="people-timeline__scrubber">
            <span className="people-timeline__sr-only">Timeline position for {personName}</span>
            <input
              type="range"
              min="0"
              max={Math.max(0, visiblePhotos.length - 1)}
              step="1"
              value={activeIndex}
              disabled={visiblePhotos.length < 2}
              aria-valuetext={`${activeIndex + 1} of ${visiblePhotos.length}, ${formatTimelinePhotoDate(displayedPhoto, timelineState.dateOverrides[displayedPhoto.key])}`}
              onChange={(event) => {
                const photo = visiblePhotos[Number(event.target.value)]
                if (photo) setActivePhotoKey(photo.key)
              }}
            />
            <span className="people-timeline__scrubber-ends" aria-hidden="true">
              <span>Oldest</span><span>Latest</span>
            </span>
          </label>

          {dateEditorOpen ? (
            <form className="people-timeline__date-editor" aria-label="Edit photo date" onSubmit={saveDate}>
              <div className="people-timeline__date-kind" role="group" aria-label="Date detail">
                <button type="button" aria-pressed={dateDraft.precision === 'year'} onClick={() => changeDatePrecision('year')}>Year</button>
                <button type="button" aria-pressed={dateDraft.precision === 'day'} onClick={() => changeDatePrecision('day')}>Date</button>
              </div>
              <label>
                <span>{dateDraft.precision === 'year' ? 'Approximate year' : 'Date'}</span>
                <input
                  type={dateDraft.precision === 'year' ? 'number' : 'date'}
                  min={dateDraft.precision === 'year' ? '1800' : '1800-01-01'}
                  max={dateDraft.precision === 'year' ? String(new Date().getFullYear() + 1) : undefined}
                  value={dateDraft.value}
                  onChange={(event) => {
                    setDateDraft((current) => ({ ...current, value: event.target.value }))
                    setDateError('')
                  }}
                />
              </label>
              <div className="people-timeline__form-actions">
                <button type="submit">Save date</button>
                <button type="button" onClick={() => setDateEditorOpen(false)}>Cancel</button>
                {timelineState.dateOverrides[displayedPhoto.key] ? (
                  <button type="button" onClick={restoreCapturedDate}>Use original</button>
                ) : null}
              </div>
              {dateError ? <p role="alert">{dateError}</p> : null}
            </form>
          ) : null}

          <div className="people-timeline__tagging">
            <button
              type="button"
              className="people-timeline__tag-toggle"
              aria-expanded={tagEditorOpen}
              onClick={() => setTagEditorOpen((current) => !current)}
            >
              People in this photo
              <span aria-hidden="true">{tagEditorOpen ? '−' : '+'}</span>
            </button>
            {tagEditorOpen ? (
              <div className="people-timeline__tag-panel">
                {timelineState.people.length ? timelineState.people.map((person) => {
                  const checked = effectivePeopleByPhoto
                    .get(displayedPhoto.key)
                    ?.has(person.id) ?? false
                  const manuallyTagged = timelineState.assignments.some((assignment) =>
                    assignment.photoKey === displayedPhoto.key &&
                    assignment.personId === person.id &&
                    assignment.source === 'manual',
                  )
                  return (
                    <label key={person.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => setPhotoTag(person.id, event.target.checked)}
                      />
                      <span>
                        {person.name}
                        {checked
                          ? <small>{manuallyTagged ? 'Confirmed by you' : 'Matched automatically'}</small>
                          : null}
                      </span>
                    </label>
                  )
                }) : (
                  <p>Add a person with a face photo above, then review or correct matches here.</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
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
            <button type="button" disabled={photoPickerBusy} onClick={openPhotoPicker}>
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
          <p className="people-timeline__empty-title">Review complete for now</p>
          <p>Clear matches were filed automatically. Uncertain faces stay unnamed until there is better evidence.</p>
          <button type="button" onClick={() => choosePerson(REVIEW_PERSON_ID)}>All photos</button>
        </div>
      ) : selectedPersonId === REVIEW_PERSON_ID ? (
        <div className="people-timeline__empty">
          <p className="people-timeline__empty-title">Add your family photos</p>
          <p>Choose one photo or a whole batch. They will be saved here immediately and organized automatically after you add family faces.</p>
          {onUploadPhotos ? (
            <button type="button" disabled={photoPickerBusy} onClick={openPhotoPicker}>
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
              : 'Family will fill with ordinary photos containing at least two enrolled people.'}
          </p>
          {onUploadPhotos && timelinePhotos.length === 0 ? (
            <button type="button" disabled={photoPickerBusy} onClick={openPhotoPicker}>
              {importingPhotos ? 'Adding…' : 'Add photos'}
            </button>
          ) : timelinePhotos.length ? (
            <button type="button" onClick={() => choosePerson(REVIEW_PERSON_ID)}>All photos</button>
          ) : null}
        </div>
      )}

      <aside className="people-timeline__privacy" aria-label="Face matching privacy">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7.5 10V7.7a4.5 4.5 0 0 1 9 0V10M5.5 10h13v10h-13zM12 14v2.5" />
        </svg>
        <div>
          <p>Face matching stays on this device</p>
          <span>Reference photos are scanned once and never stored. Your private face profiles never leave this phone.</span>
        </div>
        <div className="people-timeline__privacy-actions">
          <button
            type="button"
            disabled={
              faceDataClearing ||
              importingPhotos ||
              Boolean(scanProgress) ||
              addingPersonBusy ||
              referenceBusy ||
              !pendingScanKey ||
              enrolledPersonIds.size === 0
            }
            onClick={() => void scanPhotos()}
          >
            {scanProgress
              ? `${scanProgress.completed}/${scanProgress.total}`
              : pendingScanKey
                ? 'Check new photos'
                : 'Up to date'}
          </button>
          {scanProgress ? (
            <button type="button" onClick={cancelFaceScan}>Cancel</button>
          ) : null}
          <button
            type="button"
            className="people-timeline__clear-face-button"
            disabled={
              faceDataClearing ||
              importingPhotos ||
              addingPersonBusy ||
              referenceBusy ||
              !hasFaceData ||
              Boolean(scanProgress)
            }
            aria-expanded={confirmingClearFaceData}
            onClick={() => setConfirmingClearFaceData((current) => !current)}
          >
            {faceDataClearing ? 'Clearing…' : 'Clear face data'}
          </button>
        </div>
      </aside>
      {confirmingClearFaceData ? (
        <div className="people-timeline__clear-confirm" role="group" aria-label="Confirm clear face data">
          <p>Clear face references and detections? Names and manual photo tags will stay.</p>
          <button type="button" onClick={() => void clearFaceData()}>Clear</button>
          <button type="button" onClick={() => setConfirmingClearFaceData(false)}>Keep</button>
        </div>
      ) : null}
      {scanMessage ? (
        <p className="people-timeline__scan-status" role="status" data-error={scanError ? 'true' : 'false'}>
          {scanMessage}
        </p>
      ) : null}
    </section>
  )
}
