import type {
  DismissedFaceSuggestion,
  FaceProfile,
  FaceReference,
  PeopleTimelineState,
  StoredFaceDetection,
  StoredPhotoFaceScan,
  TimelineDateOverride,
  TimelinePerson,
  TimelinePhotoAssignment,
} from './types'
import { FACE_MODEL_REVISION, FACE_SCAN_REVISION } from './types'

const DATABASE_NAME = 'kinsphere-people-timeline'
const STORE_NAME = 'account-state'
const SCAN_STORE_NAME = 'photo-face-scans'
const DATABASE_VERSION = 2
const FALLBACK_PREFIX = 'kinsphere.peopleTimeline.v1:'
const MAX_EMBEDDING_LENGTH = 4_096
const MAX_FACES_PER_PHOTO = 20
const MAX_REFERENCES_PER_PERSON = 12
const MAX_STORED_PHOTOS = 20_000
const MAX_STORED_FACE_PIXELS = 1280

type SplitScanStorage = { version: 1; writeId: string }

// Scan objects are immutable shared session values. Weak keys avoid retaining
// biometric vectors after account departure or a clear. A committed write ID
// also invalidates this optimization after another context changes the store.
let durableScanRows: {
  namespace: string
  writeId: string
  rows: WeakMap<StoredPhotoFaceScan, Set<string>>
} | undefined

function rememberDurableScanRows(
  namespace: string,
  writeId: string,
  scans: PeopleTimelineState['faceScans'],
  storedScans?: Record<string, unknown>,
) {
  const rows = new WeakMap<StoredPhotoFaceScan, Set<string>>()
  for (const [key, scan] of Object.entries(scans)) {
    // A parser repair is a changed row, not a durable copy of the repaired
    // value. Rewrite it on the next save so removed/invalid vectors do not
    // linger in the original persisted row indefinitely.
    if (storedScans && !sameStoredValue(storedScans[key], scan)) continue
    const keys = rows.get(scan) ?? new Set<string>()
    keys.add(key)
    rows.set(scan, keys)
  }
  durableScanRows = { namespace, writeId, rows }
}

/** Only used once at hydration; normal checkpoint writes compare weak identities. */
function sameStoredValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameStoredValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameStoredValue(left[key], right[key]))
}

function splitScanStorage(value: unknown): SplitScanStorage | undefined {
  if (!isRecord(value) || !isRecord(value.faceScanStorage)) return undefined
  const marker = value.faceScanStorage
  return marker.version === 1 && typeof marker.writeId === 'string' && marker.writeId.length > 0
    ? { version: 1, writeId: marker.writeId } : undefined
}

/** Arrays sort after strings, so this range contains only this namespace's keys. */
function namespaceScanRange(namespace: string) {
  return IDBKeyRange.bound([namespace], [namespace, []])
}

function photoKeyFromScanKey(key: IDBValidKey, namespace: string) {
  return Array.isArray(key) && key.length === 2 && key[0] === namespace && typeof key[1] === 'string'
    ? key[1] : undefined
}

/** Creates the current, schema-complete people timeline state. */
export function emptyPeopleTimelineState(): PeopleTimelineState {
  return {
    version: 4,
    faceModelRevision: FACE_MODEL_REVISION,
    faceScanRevision: FACE_SCAN_REVISION,
    people: [],
    assignments: [],
    dateOverrides: {},
    faceScans: {},
    faceProfiles: {},
    dismissedSuggestions: [],
  }
}

/** Narrows untrusted persisted values before schema validation. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accepts the minimum durable identity fields required by the people rail. */
function validPerson(value: unknown): value is TimelinePerson {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.createdAt === 'string'
}

/** Validates a manual or suggested person-to-photo confirmation. */
function validAssignment(value: unknown): value is TimelinePhotoAssignment {
  return isRecord(value) &&
    typeof value.photoKey === 'string' &&
    typeof value.personId === 'string' &&
    (value.faceId === undefined || (
      typeof value.faceId === 'string' && value.faceId.length > 0
    )) &&
    (value.source === 'manual' || value.source === 'face-suggestion') &&
    typeof value.confirmedAt === 'string'
}

/** Restricts corrected dates to supported day and approximate-year formats. */
function validDateOverride(value: unknown): value is TimelineDateOverride {
  return isRecord(value) &&
    typeof value.value === 'string' &&
    (value.precision === 'day' || value.precision === 'year')
}

/** Validates the key fields used to suppress a rejected suggestion. */
function validDismissal(value: unknown): value is DismissedFaceSuggestion {
  return isRecord(value) &&
    typeof value.photoKey === 'string' &&
    typeof value.personId === 'string' &&
    (value.faceId === undefined || (
      typeof value.faceId === 'string' && value.faceId.length > 0
    )) &&
    typeof value.dismissedAt === 'string'
}

/** Bounds biometric vectors and rejects non-finite model output. */
function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_EMBEDDING_LENGTH &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

/** Accepts normalized confidence values in the closed unit interval. */
function validUnitScore(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
}

/** Validates one normalized face box, descriptor, and confidence bundle. */
function validStoredFaceDetection(value: unknown): value is StoredFaceDetection {
  if (!isRecord(value) || !Array.isArray(value.box) || value.box.length !== 4) {
    return false
  }
  if (!value.box.every(validUnitScore)) return false
  const [x, y, width, height] = value.box
  return typeof value.id === 'string' &&
    value.id.length > 0 &&
    validEmbedding(value.embedding) &&
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    width > 0 &&
    height > 0 &&
    x + width <= 1.000_001 &&
    y + height <= 1.000_001 &&
    validUnitScore(value.detectorScore) &&
    validUnitScore(value.descriptorScore) &&
    validUnitScore(value.quality)
}

/** Validates an enrollment or user-confirmed reference descriptor. */
function validFaceReference(value: unknown): value is FaceReference {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    validEmbedding(value.embedding) &&
    (value.source === 'enrollment' || value.source === 'manual-photo') &&
    typeof value.createdAt === 'string' &&
    (value.quality === undefined || validUnitScore(value.quality)) &&
    (value.photoKey === undefined || typeof value.photoKey === 'string') &&
    (value.faceId === undefined || (
      typeof value.faceId === 'string' && value.faceId.length > 0
    ))
}

/** Clones a validated detection so persisted arrays cannot be mutated by callers. */
function normalizedDetection(detection: StoredFaceDetection): StoredFaceDetection {
  return {
    id: detection.id,
    embedding: [...detection.embedding],
    box: [
      detection.box[0],
      detection.box[1],
      detection.box[2],
      detection.box[3],
    ],
    detectorScore: detection.detectorScore,
    descriptorScore: detection.descriptorScore,
    quality: detection.quality,
    ...(detection.minFacePixels === undefined ? {} : {
      // Explicit malformed metadata is not a legacy missing measurement. Keep
      // a zero sentinel so it cannot enable automatic matches via inference.
      minFacePixels: typeof detection.minFacePixels === 'number' &&
        Number.isFinite(detection.minFacePixels) && detection.minFacePixels > 0 &&
        detection.minFacePixels <= MAX_STORED_FACE_PIXELS ? detection.minFacePixels : 0,
    }),
  }
}

/** Removes dangling face links while cloning a validated reference. */
function normalizedReference(
  reference: FaceReference,
  faceScans: PeopleTimelineState['faceScans'],
): FaceReference {
  const linkedFaceExists = Boolean(
    reference.photoKey &&
    reference.faceId &&
    faceScans[reference.photoKey]?.faces.some(({ id }) => id === reference.faceId),
  )
  return {
    id: reference.id,
    embedding: [...reference.embedding],
    source: reference.source,
    createdAt: reference.createdAt,
    ...(reference.quality === undefined ? {} : { quality: reference.quality }),
    ...(linkedFaceExists
      ? { photoKey: reference.photoKey, faceId: reference.faceId }
      : {}),
  }
}

/** Preserves an optional face link only when that face still exists. */
function normalizedAssignment(
  assignment: TimelinePhotoAssignment,
  faceScans: PeopleTimelineState['faceScans'],
): TimelinePhotoAssignment {
  const faceId = assignment.faceId && faceScans[assignment.photoKey]?.faces
    .some(({ id }) => id === assignment.faceId)
    ? assignment.faceId
    : undefined
  return {
    photoKey: assignment.photoKey,
    personId: assignment.personId,
    ...(faceId ? { faceId } : {}),
    source: assignment.source,
    confirmedAt: assignment.confirmedAt,
  }
}

/** Downgrades stale face-specific dismissals to person/photo dismissals. */
function normalizedDismissal(
  dismissal: DismissedFaceSuggestion,
  faceScans: PeopleTimelineState['faceScans'],
): DismissedFaceSuggestion {
  const faceId = dismissal.faceId && faceScans[dismissal.photoKey]?.faces
    .some(({ id }) => id === dismissal.faceId)
    ? dismissal.faceId
    : undefined
  return {
    photoKey: dismissal.photoKey,
    personId: dismissal.personId,
    ...(faceId ? { faceId } : {}),
    dismissedAt: dismissal.dismissedAt,
  }
}

/** Validates, bounds, and migrates untrusted persisted timeline state. */
export function parsePeopleTimelineState(value: unknown): PeopleTimelineState {
  if (!isRecord(value)) return emptyPeopleTimelineState()
  const people = Array.isArray(value.people)
    ? value.people.filter(validPerson).slice(0, 100)
    : []
  const personIds = new Set(people.map(({ id }) => id))
  const peopleById = new Map(people.map((person) => [person.id, person]))
  const dateOverrides: Record<string, TimelineDateOverride> = {}
  if (isRecord(value.dateOverrides)) {
    for (const [photoKey, dateOverride] of Object.entries(value.dateOverrides)) {
      if (validDateOverride(dateOverride)) dateOverrides[photoKey] = dateOverride
    }
  }
  const hasCurrentFaceModel = value.faceModelRevision === FACE_MODEL_REVISION
  const hasCurrentFaceScan = hasCurrentFaceModel &&
    value.faceScanRevision === FACE_SCAN_REVISION
  const faceScans: Record<string, StoredPhotoFaceScan> = {}
  let storedPhotoCount = 0
  if (hasCurrentFaceScan && isRecord(value.faceScans)) {
    for (const [photoKey, rawScan] of Object.entries(value.faceScans)) {
      if (!photoKey || !isRecord(rawScan) || typeof rawScan.scannedAt !== 'string') {
        continue
      }
      if (!Array.isArray(rawScan.faces)) continue
      const seenFaceIds = new Set<string>()
      const faces: StoredFaceDetection[] = []
      for (const rawFace of rawScan.faces) {
        if (!validStoredFaceDetection(rawFace) || seenFaceIds.has(rawFace.id)) continue
        seenFaceIds.add(rawFace.id)
        faces.push(normalizedDetection(rawFace))
        if (faces.length >= MAX_FACES_PER_PHOTO) break
      }
      faceScans[photoKey] = { scannedAt: rawScan.scannedAt, faces }
      // Object.entries supplies unique keys. Count accepted own entries in
      // constant time instead of re-enumerating the growing gallery per photo.
      if (Object.hasOwn(faceScans, photoKey)) storedPhotoCount += 1
      if (storedPhotoCount >= MAX_STORED_PHOTOS) break
    }
  }

  const faceProfiles: Record<string, FaceProfile> = {}
  if (hasCurrentFaceModel && isRecord(value.faceProfiles)) {
    for (const [personId, rawProfile] of Object.entries(value.faceProfiles)) {
      if (!personIds.has(personId) || !isRecord(rawProfile) ||
        !Array.isArray(rawProfile.references)) continue
      const references: FaceReference[] = []
      const seenReferenceIds = new Set<string>()
      for (const rawReference of rawProfile.references) {
        if (!validFaceReference(rawReference) || seenReferenceIds.has(rawReference.id)) {
          continue
        }
        seenReferenceIds.add(rawReference.id)
        references.push(normalizedReference(rawReference, faceScans))
        if (references.length >= MAX_REFERENCES_PER_PERSON) break
      }
      if (references.length) faceProfiles[personId] = { references }
    }
  }

  // v3 stored exactly one enrollment vector per person. It uses the same
  // FaceRes model, so preserve that explicit enrollment while requiring every
  // library photo to be rescanned with the revised preprocessing pipeline.
  if (hasCurrentFaceModel && isRecord(value.referenceEmbeddings)) {
    for (const [personId, embedding] of Object.entries(value.referenceEmbeddings)) {
      if (faceProfiles[personId] || !personIds.has(personId) ||
        !validEmbedding(embedding)) continue
      const person = peopleById.get(personId)
      if (!person) continue
      faceProfiles[personId] = {
        references: [{
          id: `legacy-enrollment:${personId}:0`,
          embedding: [...embedding],
          source: 'enrollment',
          createdAt: person.createdAt,
        }],
      }
    }
  }

  const assignments = Array.isArray(value.assignments)
    ? value.assignments
      .filter(validAssignment)
      .filter(({ personId, source }) =>
        personIds.has(personId) && (hasCurrentFaceScan || source === 'manual'),
      )
      .slice(0, 20_000)
      .map((assignment) => normalizedAssignment(assignment, faceScans))
    : []
  const dismissedSuggestions = Array.isArray(value.dismissedSuggestions)
    ? value.dismissedSuggestions
      .filter(validDismissal)
      .filter(({ personId }) => personIds.has(personId))
      .slice(0, 20_000)
      .map((dismissal) => normalizedDismissal(dismissal, faceScans))
    : []
  return {
    version: 4,
    faceModelRevision: FACE_MODEL_REVISION,
    faceScanRevision: FACE_SCAN_REVISION,
    people,
    assignments,
    dateOverrides,
    faceScans,
    faceProfiles,
    dismissedSuggestions,
  }
}

/** Names the metadata-only fallback by account and family namespace. */
function fallbackKey(cacheNamespace: string) {
  return `${FALLBACK_PREFIX}${encodeURIComponent(cacheNamespace || 'local')}`
}

/** Strips private descriptors before any state enters localStorage. */
function withoutBiometricVectors(state: PeopleTimelineState): PeopleTimelineState {
  return {
    ...state,
    faceScans: {},
    faceProfiles: {},
  }
}

/** Reports whether a save requires IndexedDB's biometric-capable boundary. */
function hasBiometricVectors(state: PeopleTimelineState) {
  return Object.keys(state.faceScans).length > 0 ||
    Object.keys(state.faceProfiles).length > 0
}

/** Detects current and legacy vector fields in an untrusted fallback record. */
function storedValueHasBiometricVectors(value: unknown) {
  if (!isRecord(value)) return false
  return (
    isRecord(value.faceScans) && Object.keys(value.faceScans).length > 0
  ) || (
    isRecord(value.faceProfiles) && Object.keys(value.faceProfiles).length > 0
  ) || (
    isRecord(value.embeddings) && Object.keys(value.embeddings).length > 0
  ) || (
    isRecord(value.referenceEmbeddings) &&
    Object.keys(value.referenceEmbeddings).length > 0
  )
}

/** Reads metadata-only fallback state and scrubs vectors left by old versions. */
function readFallback(cacheNamespace: string) {
  const key = fallbackKey(cacheNamespace)
  try {
    const value = window.localStorage.getItem(key)
    if (!value) return null
    const storedValue = JSON.parse(value) as unknown
    const parsed = parsePeopleTimelineState(storedValue)
    const metadataOnly = withoutBiometricVectors(parsed)
    // Older app versions could place face vectors in localStorage. Rewrite
    // the record immediately so reading a legacy fallback also removes them.
    if (storedValueHasBiometricVectors(storedValue)) {
      window.localStorage.setItem(
        key,
        JSON.stringify(metadataOnly),
      )
    }
    return metadataOnly
  } catch {
    // If rewriting a legacy biometric-bearing value fails (for example due
    // to quota pressure), removal is safer than leaving the old JSON behind.
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Storage may be completely unavailable in private browsing.
    }
    return null
  }
}

/** Persists non-biometric state when IndexedDB is unavailable. */
function saveFallback(cacheNamespace: string, state: PeopleTimelineState) {
  try {
    window.localStorage.setItem(
      fallbackKey(cacheNamespace),
      JSON.stringify(withoutBiometricVectors(state)),
    )
    return true
  } catch {
    // Manual controls remain available for the current session.
    return false
  }
}

/** Removes stale fallback state after IndexedDB becomes authoritative. */
function removeFallback(cacheNamespace: string) {
  try {
    window.localStorage.removeItem(fallbackKey(cacheNamespace))
    return true
  } catch {
    return false
  }
}

/** Opens the single IndexedDB database whose keys provide account isolation. */
function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains(SCAN_STORE_NAME)) {
        request.result.createObjectStore(SCAN_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
    request.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
}

/** Reads one consistent account snapshot, including its separately stored scans. */
async function readIndexedDatabase(cacheNamespace: string) {
  const database = await openDatabase()
  try {
    return await new Promise<{ state: unknown; writeId?: string }>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, SCAN_STORE_NAME], 'readonly')
      let result: { state: unknown; writeId?: string } = { state: undefined }
      const request = transaction.objectStore(STORE_NAME).get(cacheNamespace)
      request.onsuccess = () => {
        const state: unknown = request.result
        const marker = splitScanStorage(state)
        result = { state }
        if (!marker || !isRecord(state)) return
        const store = transaction.objectStore(SCAN_STORE_NAME)
        const keys = store.getAllKeys(namespaceScanRange(cacheNamespace))
        const scans = store.getAll(namespaceScanRange(cacheNamespace))
        const assemble = () => {
          if (keys.readyState !== 'done' || scans.readyState !== 'done') return
          result = {
            state: { ...state, faceScans: Object.fromEntries(keys.result.flatMap((key, index) => {
              const photoKey = photoKeyFromScanKey(key, cacheNamespace)
              return photoKey === undefined ? [] : [[photoKey, scans.result[index]]]
            })) },
            writeId: marker.writeId,
          }
        }
        keys.onsuccess = assemble
        scans.onsuccess = assemble
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error('Local read failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Local read aborted'))
    })
  } finally {
    database.close()
  }
}

/** Atomically commits metadata plus changed rows, never recopying old vectors. */
async function saveIndexedDatabase(
  cacheNamespace: string,
  state: PeopleTimelineState,
) {
  const database = await openDatabase()
  try {
    const writeId = crypto.randomUUID()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, SCAN_STORE_NAME], 'readwrite')
      const accountStore = transaction.objectStore(STORE_NAME)
      const scanStore = transaction.objectStore(SCAN_STORE_NAME)
      const previous = accountStore.get(cacheNamespace)
      const storedKeys = scanStore.getAllKeys(namespaceScanRange(cacheNamespace))
      const commit = () => {
        if (previous.readyState !== 'done' || storedKeys.readyState !== 'done') return
        try {
          const marker = splitScanStorage(previous.result)
          const knownRows = marker && durableScanRows?.namespace === cacheNamespace &&
            durableScanRows.writeId === marker.writeId &&
            isRecord(previous.result) && previous.result.faceModelRevision === state.faceModelRevision &&
            previous.result.faceScanRevision === state.faceScanRevision
            ? durableScanRows.rows : undefined
          const existing = new Set<string>()
          for (const key of storedKeys.result) {
            const photoKey = photoKeyFromScanKey(key, cacheNamespace)
            if (photoKey === undefined) { scanStore.delete(key); continue }
            existing.add(photoKey)
            if (!Object.hasOwn(state.faceScans, photoKey)) scanStore.delete(key)
          }
          for (const [photoKey, scan] of Object.entries(state.faceScans)) {
            if (!existing.has(photoKey) || !knownRows?.get(scan)?.has(photoKey)) {
              scanStore.put(scan, [cacheNamespace, photoKey])
            }
          }
          // The first save of an old single-record snapshot performs the same
          // migration transaction. An abort leaves the old snapshot readable.
          accountStore.put({ ...state, faceScans: {},
            faceScanStorage: { version: 1, writeId } satisfies SplitScanStorage,
          }, cacheNamespace)
        } catch (failure) {
          transaction.abort()
          reject(failure)
        }
      }
      previous.onsuccess = commit
      storedKeys.onsuccess = commit
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Local save failed'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Local save aborted'))
    })
    rememberDurableScanRows(cacheNamespace, writeId, state.faceScans)
  } finally {
    database.close()
  }
}

/** Loads one account/family timeline from IndexedDB with localStorage fallback. */
export async function loadPeopleTimelineState(cacheNamespace: string) {
  if (typeof window === 'undefined') return emptyPeopleTimelineState()
  // A fallback exists only when IndexedDB was unavailable or its cleanup
  // could not be verified. Prefer that metadata-only record so an older
  // IndexedDB snapshot cannot resurrect biometric vectors after a clear.
  const fallback = readFallback(cacheNamespace)
  if (fallback) return fallback
  if ('indexedDB' in window) {
    try {
      const stored = await readIndexedDatabase(cacheNamespace)
      if (stored.state !== undefined) {
        const parsed = parsePeopleTimelineState(stored.state)
        if (stored.writeId && isRecord(stored.state) && isRecord(stored.state.faceScans)) {
          rememberDurableScanRows(cacheNamespace, stored.writeId, parsed.faceScans, stored.state.faceScans)
        }
        return parsed
      }
    } catch {
      // Private browsing and older WebViews may not permit IndexedDB.
    }
  }
  return emptyPeopleTimelineState()
}

/** Persists a validated timeline snapshot to durable and fallback storage. */
export async function savePeopleTimelineState(
  cacheNamespace: string,
  state: PeopleTimelineState,
) {
  if (typeof window === 'undefined') return false
  if ('indexedDB' in window) {
    try {
      await saveIndexedDatabase(cacheNamespace, state)
      // IndexedDB is authoritative once it succeeds. Removing an older
      // fallback prevents cleared embeddings from resurfacing if IndexedDB is
      // temporarily unavailable on a later launch.
      const fallbackRemoved = removeFallback(cacheNamespace)
      if (!fallbackRemoved) {
        // Best-effort overwrite still scrubs vectors from a legacy fallback;
        // report false because we could not prove that cleanup was durable.
        saveFallback(cacheNamespace, state)
      }
      return fallbackRemoved
    } catch {
      // Fall back to an account-namespaced local cache.
    }
  }
  const metadataSaved = saveFallback(cacheNamespace, state)
  // A caller checkpointing a face scan must not be told that its biometric
  // result was durable when only the metadata-safe fallback was written.
  return metadataSaved && !hasBiometricVectors(state)
}
