import type { UnlockedCapsulePhoto } from '../capsuleJournalArchive'
import { canonicalCapsulePhotos } from '../canonicalCapsulePhotos'
import {
  JOURNAL_LIBRARY_ID,
  type JournalPhoto,
} from '../journalPhotoTypes'
import type {
  FaceReference,
  FaceSuggestion,
  PeopleTimelinePhoto,
  PeopleTimelineState,
  StoredFaceDetection,
  TimelineDateOverride,
} from './types'

const MAX_SUPPLEMENTAL_REFERENCES_PER_PERSON = 64
const FACE_RES_DESCRIPTOR_LENGTH = 1_024
const MINIMUM_SUPPLEMENTAL_REFERENCE_QUALITY = 0.55
const MINIMUM_AUTOMATIC_REFERENCE_QUALITY = 0.62
const DEFAULT_HIGH_SIMILARITY = 0.86
const DEFAULT_HIGH_FACE_MARGIN = 0.12
const DEFAULT_HIGH_PERSON_MARGIN = 0.08
// Review is a narrow band of plausible matches, not a queue of every detected
// face. These are model similarity scores, not calibrated identity probabilities.
// Uncertain matches remain available for manual tagging and can be reconsidered
// when a person gains a confirmed appearance. Raising automatic precision must
// not send the old, permissive acceptance band wholesale into the review queue.
const DEFAULT_REVIEW_SIMILARITY = 0.78
const DEFAULT_REVIEW_FACE_MARGIN = 0.03
const DEFAULT_REVIEW_PERSON_MARGIN = 0.02
const MINIMUM_HIGH_FACE_QUALITY = 0.75
const MINIMUM_REVIEW_FACE_QUALITY = 0.55
const FACE_RES_DISTANCE_MULTIPLIER = 25
const FACE_RES_NORMALIZATION_MIN = 0.2
const FACE_RES_NORMALIZATION_MAX = 0.8

/** Converts journal and Capsule sources into one deduplicated timeline model. */
export function toPeopleTimelinePhotos(
  photos: readonly UnlockedCapsulePhoto[],
  journalPhotos: readonly JournalPhoto[] = [],
): PeopleTimelinePhoto[] {
  const capsulePhotos: PeopleTimelinePhoto[] = canonicalCapsulePhotos(photos).map((photo) => ({
    key: `photo:${photo.id}`,
    id: photo.id,
    kind: 'capsule-photo',
    source: photo.thumbnail,
    scanSource: photo.image,
    displayWidth: photo.width,
    displayHeight: photo.height,
    capturedAt: photo.capturedAt,
    caption: photo.caption.trim() || photo.capsuleTitle,
    contributorName: photo.contributorName,
    capsuleId: photo.capsuleId,
    memoryId: `capsule-${photo.capsuleId}-${photo.id}`,
    canScanFaces: true,
    legacyKeys: [`capsule:${photo.capsuleId}:${photo.id}`],
  }))
  const directPhotos: PeopleTimelinePhoto[] = journalPhotos.map((photo) => ({
    key: `journal-photo:${photo.id}`,
    id: photo.id,
    kind: 'journal-photo',
    origin: photo.origin,
    source: photo.thumbnail,
    scanSource: photo.image,
    displayWidth: photo.width,
    displayHeight: photo.height,
    capturedAt: photo.capturedAt,
    caption: photo.caption.trim() || 'Family photo',
    contributorName: photo.contributorName,
    capsuleId: JOURNAL_LIBRARY_ID,
    memoryId: `journal-photo-${photo.id}`,
    canScanFaces: true,
  }))
  return [...capsulePhotos, ...directPhotos]
}

/** Builds a content-ID resolver for unstable Capsule IDs stored before v4. */
function createLegacyPhotoKeyResolver(
  capsulePhotos: readonly PeopleTimelinePhoto[],
): (storedKey: string) => string {
  // Legacy keys include a Capsule ID that is no longer stable. Resolve by the
  // longest photo-ID suffix so overlapping IDs cannot capture each other.
  const photosByLongestId = [...capsulePhotos].sort(
    (left, right) => right.id.length - left.id.length,
  )
  return (storedKey) => {
    if (!storedKey.startsWith('capsule:')) return storedKey
    const matchingPhoto = photosByLongestId.find((photo) =>
      storedKey.endsWith(`:${photo.id}`),
    )
    return matchingPhoto?.key ?? storedKey
  }
}

/** Remaps legacy source-specific photo keys onto current content-stable keys. */
export function migrateLegacyPeopleTimelineState(
  state: PeopleTimelineState,
  photos: readonly PeopleTimelinePhoto[],
) {
  const capsulePhotos = photos.filter(
    (photo) => photo.kind === 'capsule-photo',
  )
  const migratePhotoKey = createLegacyPhotoKeyResolver(capsulePhotos)
  let changed = false

  const assignmentsByKey = new Map<string, PeopleTimelineState['assignments'][number]>()
  for (const assignment of state.assignments) {
    const photoKey = migratePhotoKey(assignment.photoKey)
    if (photoKey !== assignment.photoKey) changed = true
    const nextAssignment = { ...assignment, photoKey }
    const key = `${photoKey}\u0000${assignment.personId}`
    const existing = assignmentsByKey.get(key)
    if (!existing || (existing.source === 'face-suggestion' && assignment.source === 'manual')) {
      assignmentsByKey.set(key, nextAssignment)
    }
  }

  const dateOverrides: PeopleTimelineState['dateOverrides'] = {}
  for (const [storedKey, dateOverride] of Object.entries(state.dateOverrides)) {
    const photoKey = migratePhotoKey(storedKey)
    if (photoKey !== storedKey) changed = true
    if (!dateOverrides[photoKey] || photoKey === storedKey) {
      dateOverrides[photoKey] = dateOverride
    }
  }

  const faceScans: PeopleTimelineState['faceScans'] = {}
  for (const [storedKey, scan] of Object.entries(state.faceScans)) {
    const photoKey = migratePhotoKey(storedKey)
    if (photoKey !== storedKey) changed = true
    if (!faceScans[photoKey] || photoKey === storedKey) {
      faceScans[photoKey] = scan
    }
  }

  const faceProfiles: PeopleTimelineState['faceProfiles'] = {}
  for (const [personId, profile] of Object.entries(state.faceProfiles)) {
    faceProfiles[personId] = {
      references: profile.references.map((reference) => {
        if (!reference.photoKey) return reference
        const photoKey = migratePhotoKey(reference.photoKey)
        if (photoKey !== reference.photoKey) changed = true
        return photoKey === reference.photoKey
          ? reference
          : { ...reference, photoKey }
      }),
    }
  }

  const dismissalsByKey = new Map<string, PeopleTimelineState['dismissedSuggestions'][number]>()
  for (const dismissal of state.dismissedSuggestions) {
    const photoKey = migratePhotoKey(dismissal.photoKey)
    if (photoKey !== dismissal.photoKey) changed = true
    const key = `${photoKey}\u0000${dismissal.faceId ?? ''}\u0000${dismissal.personId}`
    dismissalsByKey.set(key, { ...dismissal, photoKey })
  }

  if (!changed) return state
  return {
    ...state,
    version: 4 as const,
    assignments: [...assignmentsByKey.values()],
    dateOverrides,
    faceScans,
    faceProfiles,
    dismissedSuggestions: [...dismissalsByKey.values()],
  }
}

/** Converts partial date overrides into sortable midday/representative times. */
function parsedOverrideTime(override: TimelineDateOverride | undefined) {
  if (!override) return Number.NaN
  if (override.precision === 'year') {
    const year = Number.parseInt(override.value, 10)
    return Number.isInteger(year) ? Date.UTC(year, 6, 1) : Number.NaN
  }
  return new Date(`${override.value}T12:00:00`).getTime()
}

/** Resolves a photo's effective timestamp after a user date correction. */
export function timelinePhotoTime(
  photo: PeopleTimelinePhoto,
  dateOverrides: PeopleTimelineState['dateOverrides'],
) {
  const overrideTime = parsedOverrideTime(dateOverrides[photo.key])
  if (Number.isFinite(overrideTime)) return overrideTime
  const capturedTime = new Date(photo.capturedAt).getTime()
  return Number.isFinite(capturedTime) ? capturedTime : Number.MAX_SAFE_INTEGER
}

/** Sorts photos oldest-first using corrected dates and deterministic tie breaks. */
export function sortTimelinePhotos(
  photos: readonly PeopleTimelinePhoto[],
  dateOverrides: PeopleTimelineState['dateOverrides'],
) {
  return [...photos].sort((left, right) => {
    const difference = timelinePhotoTime(left, dateOverrides) -
      timelinePhotoTime(right, dateOverrides)
    return difference || left.key.localeCompare(right.key)
  })
}

/** Formats the effective date at the precision selected by the user. */
export function formatTimelinePhotoDate(
  photo: PeopleTimelinePhoto,
  dateOverride?: TimelineDateOverride,
) {
  if (dateOverride?.precision === 'year') {
    return `Around ${dateOverride.value}`
  }
  const rawDate = dateOverride?.value
    ? new Date(`${dateOverride.value}T12:00:00`)
    : new Date(photo.capturedAt)
  if (!Number.isFinite(rawDate.getTime())) return 'Date unknown'
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(rawDate)
}

/** Measures descriptor similarity and safely rejects incompatible vectors. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  if (left.length === 0 || left.length !== right.length) return -1
  let product = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    product += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return -1
  return product / Math.sqrt(leftMagnitude * rightMagnitude)
}

/**
 * Matches the distance and normalization used by Human's HSE FaceRes model.
 *
 * FaceRes descriptors are not unit vectors, so cosine similarity discards
 * meaningful magnitude information. Human instead uses a scaled Euclidean
 * distance and normalizes the result to the model's calibrated 0.2..0.8
 * range. Keeping this implementation local also keeps matching synchronous
 * and independent from whichever inference backend scanned the photo.
 */
export function faceResSimilarity(
  left: readonly number[],
  right: readonly number[],
) {
  if (
    left.length !== FACE_RES_DESCRIPTOR_LENGTH ||
    left.length !== right.length
  ) return -1

  let squaredDistance = 0
  let leftHasSignal = false
  let rightHasSignal = false
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (
      leftValue === undefined ||
      rightValue === undefined ||
      !Number.isFinite(leftValue) ||
      !Number.isFinite(rightValue)
    ) return -1
    const difference = leftValue - rightValue
    squaredDistance += difference * difference
    leftHasSignal ||= leftValue !== 0
    rightHasSignal ||= rightValue !== 0
  }
  if (!leftHasSignal || !rightHasSignal) return -1
  if (squaredDistance === 0) return 1

  // Human rounds the amplified distance before taking its root.
  const amplifiedDistance = Math.round(
    100 * FACE_RES_DISTANCE_MULTIPLIER * squaredDistance,
  ) / 100
  const distanceRoot = Math.sqrt(amplifiedDistance)
  const normalized = (
    1 - (distanceRoot / 100) - FACE_RES_NORMALIZATION_MIN
  ) / (
    FACE_RES_NORMALIZATION_MAX - FACE_RES_NORMALIZATION_MIN
  )
  return Math.round(100 * Math.max(0, Math.min(1, normalized))) / 100
}

// Timeline descriptors are immutable. Validate each one once so thousands
// of pair comparisons only perform the numeric distance loop. Weak keys release
// both prepared vectors and pair scores when their owning state is discarded.
const preparedDescriptors = new WeakMap<readonly number[], readonly number[] | null>()
const referenceSimilarities = new WeakMap<readonly number[], WeakMap<readonly number[], number>>()

function preparedDescriptor(values: readonly number[]) {
  if (preparedDescriptors.has(values)) return preparedDescriptors.get(values) ?? null
  if (values.length !== FACE_RES_DESCRIPTOR_LENGTH) {
    preparedDescriptors.set(values, null)
    return null
  }
  let hasSignal = false
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined || !Number.isFinite(value)) {
      preparedDescriptors.set(values, null)
      return null
    }
    hasSignal ||= value !== 0
  }
  preparedDescriptors.set(values, hasSignal ? values : null)
  return hasSignal ? values : null
}

function cachedFaceResSimilarity(left: readonly number[], right: readonly number[]) {
  let cached = referenceSimilarities.get(left)
  const existing = cached?.get(right)
  if (existing !== undefined) return existing
  const preparedLeft = preparedDescriptor(left)
  const preparedRight = preparedDescriptor(right)
  let squaredDistance = 0
  if (preparedLeft && preparedRight) {
    for (let index = 0; index < FACE_RES_DESCRIPTOR_LENGTH; index += 1) {
      const difference = preparedLeft[index]! - preparedRight[index]!
      squaredDistance += difference * difference
    }
  }
  let score = -1
  if (preparedLeft && preparedRight) {
    if (squaredDistance === 0) score = 1
    else {
      const amplified = Math.round(100 * FACE_RES_DISTANCE_MULTIPLIER * squaredDistance) / 100
      const normalized = (1 - Math.sqrt(amplified) / 100 - FACE_RES_NORMALIZATION_MIN) /
        (FACE_RES_NORMALIZATION_MAX - FACE_RES_NORMALIZATION_MIN)
      score = Math.round(100 * Math.max(0, Math.min(1, normalized))) / 100
    }
  }
  if (!cached) { cached = new WeakMap(); referenceSimilarities.set(left, cached) }
  cached.set(right, score)
  return score
}

/** Scores a detected face against the best known appearance for one person. */
function strongestReferenceSimilarity(
  detectedFace: readonly number[],
  references: readonly FaceReference[],
) {
  let strongest = -1
  for (const reference of references) {
    strongest = Math.max(
      strongest,
      cachedFaceResSimilarity(detectedFace, reference.embedding),
    )
  }
  return strongest
}

type MatchReference = FaceReference & { automaticAnchor: boolean }

/** Explicit face confirmations teach new appearances; inferred labels never do. */
function automaticReferenceConfidence(
  embedding: readonly number[],
  references: readonly MatchReference[],
  minimumSimilarity: number,
) {
  const trusted = references.filter(({ quality, automaticAnchor }) => automaticAnchor && quality !== undefined &&
    Number.isFinite(quality) && quality >= MINIMUM_AUTOMATIC_REFERENCE_QUALITY)
    .map((reference) => ({ reference, score: strongestReferenceSimilarity(embedding, [reference]) }))
    .sort((left, right) => right.score - left.score)
  const strongest = trusted[0]
  if (!strongest) return -1
  // A user-confirmed childhood/older appearance is as intentional as a new
  // enrollment photo. Requiring the original portrait to agree again prevents
  // that confirmation from ever helping. Keep the strict single-view cutoff.
  if (clearsMatchThreshold(strongest.score, Math.min(1, minimumSimilarity + 0.06))) {
    return strongest.score
  }
  const independent = trusted.find(({ reference, score }) =>
    reference !== strongest.reference &&
    !(reference.photoKey && reference.photoKey === strongest.reference.photoKey) &&
    strongestReferenceSimilarity(reference.embedding, [strongest.reference]) < 0.99 &&
    clearsMatchThreshold(score, minimumSimilarity - 0.04))
  return independent ? strongest.score : -1
}

type FaceMatchDecision = FaceSuggestion & {
  faceId: string
}

type PersonReferences = {
  personId: string
  references: MatchReference[]
}

type ScoredFace = {
  detection: StoredFaceDetection
  scores: Array<{
    personId: string
    confidence: number
    automaticConfidence: number
  }>
}

type MatchThresholds = {
  minimumSimilarity: number
  minimumFaceMargin: number
  minimumPersonMargin: number
  minimumFaceQuality: number
  automatic: boolean
}

/** Rejects undersized or non-finite descriptors before matching. */
function validReference(reference: FaceReference) {
  return reference.embedding.length === FACE_RES_DESCRIPTOR_LENGTH &&
    reference.embedding.every(Number.isFinite) && reference.embedding.some((value) => value !== 0) &&
    (reference.quality === undefined || (Number.isFinite(reference.quality) &&
      reference.quality >= MINIMUM_SUPPLEMENTAL_REFERENCE_QUALITY && reference.quality <= 1))
}

/** Builds per-person reference sets, including bounded confirmed appearances. */
function referenceProfiles(state: PeopleTimelineState): PersonReferences[] {
  const rejected = new Set(state.dismissedSuggestions.map(({ photoKey, faceId, personId }) =>
    faceDecisionKey(photoKey, faceId ?? '*', personId)))
  const confirmedAnchors = new Set(state.assignments.flatMap((assignment) =>
    assignment.source === 'manual' && assignment.faceId
      ? [faceDecisionKey(assignment.photoKey, assignment.faceId, assignment.personId)] : []))
  const profiles = state.people.flatMap(({ id: personId }) => {
    const profile = state.faceProfiles[personId]
    const references = profile?.references.filter((reference) => validReference(reference) &&
      (!reference.photoKey || (!rejected.has(faceDecisionKey(reference.photoKey, '*', personId)) &&
        !rejected.has(faceDecisionKey(reference.photoKey, reference.faceId ?? '', personId)))))
      .map((reference): MatchReference => ({
        ...reference,
        automaticAnchor: reference.source === 'enrollment' || Boolean(reference.photoKey && reference.faceId &&
          confirmedAnchors.has(faceDecisionKey(reference.photoKey, reference.faceId, personId))),
      })) ?? []
    return references.length > 0 ? [{ personId, references: [...references] }] : []
  })
  const profilesByPerson = new Map(
    profiles.map((profile) => [profile.personId, profile]),
  )
  const supplementalCounts = new Map<string, number>()

  // A whole-photo tag is not enough to know which descriptor belongs to the
  // person in a group. Only an explicit person-to-face confirmation may teach
  // the profile a new appearance, pose, or age.
  for (let index = state.assignments.length - 1; index >= 0; index -= 1) {
    const assignment = state.assignments[index]
    if (!assignment) continue
    if (assignment.source !== 'manual' || !assignment.faceId ||
      rejected.has(faceDecisionKey(assignment.photoKey, '*', assignment.personId)) ||
      rejected.has(faceDecisionKey(assignment.photoKey, assignment.faceId, assignment.personId))) continue
    const enrolledPerson = profilesByPerson.get(assignment.personId)
    const detectedFace = state.faceScans[assignment.photoKey]?.faces
      .find(({ id }) => id === assignment.faceId)
    if (
      !enrolledPerson ||
      !detectedFace ||
      !Number.isFinite(detectedFace.quality) || detectedFace.quality > 1 ||
      detectedFace.quality < MINIMUM_SUPPLEMENTAL_REFERENCE_QUALITY ||
      detectedFace.embedding.length !== FACE_RES_DESCRIPTOR_LENGTH ||
      !detectedFace.embedding.every(Number.isFinite) ||
      !detectedFace.embedding.some((value) => value !== 0)
    ) continue
    const supplementalCount = supplementalCounts.get(assignment.personId) ?? 0
    if (supplementalCount >= MAX_SUPPLEMENTAL_REFERENCES_PER_PERSON) continue

    // An orphan/legacy untrusted reference must not swallow a new explicit
    // confirmation just because its vector is identical. The new confirmation
    // supplies provenance (and measured quality) that the old row lacks.
    const alreadyIncluded = enrolledPerson.references.some((reference) =>
      reference.automaticAnchor && reference.quality !== undefined &&
      reference.quality >= MINIMUM_AUTOMATIC_REFERENCE_QUALITY && ((
        reference.photoKey === assignment.photoKey &&
        reference.faceId === assignment.faceId
      ) || cachedFaceResSimilarity(reference.embedding, detectedFace.embedding) === 1),
    )
    if (alreadyIncluded) continue
    enrolledPerson.references.push({
      id: `confirmed:${assignment.photoKey}:${assignment.faceId}`,
      embedding: detectedFace.embedding,
      source: 'manual-photo',
      automaticAnchor: true,
      createdAt: assignment.confirmedAt,
      quality: detectedFace.quality,
      photoKey: assignment.photoKey,
      faceId: assignment.faceId,
    })
    supplementalCounts.set(assignment.personId, supplementalCount + 1)
  }

  return profiles
}

/** Requires weak detections to clear a stricter similarity threshold. */
function qualityAdjustedThreshold(
  minimumSimilarity: number,
  faceQuality: number,
) {
  // Lower-quality detections must be more convincing, not less. At the hard
  // quality floor this adds at most four to six percentage points.
  const qualityPenalty = Math.max(0, 0.62 - faceQuality) * 0.2
  return Math.min(1, minimumSimilarity + qualityPenalty)
}

/** Creates a collision-safe identity for one face/person decision. */
function faceDecisionKey(photoKey: string, faceId: string, personId: string) {
  return `${photoKey}\u0000${faceId}\u0000${personId}`
}

/** Keeps inclusive cutoffs inclusive despite binary rounding in score margins. */
function clearsMatchThreshold(value: number, minimum: number) {
  return value + 1e-9 >= minimum
}

/** Separates actual face detail from mesh confidence; supports old saved scans. */
function faceDetailPixels(face: StoredFaceDetection) {
  if (face.minFacePixels !== undefined) {
    return Number.isFinite(face.minFacePixels) && face.minFacePixels <= 1280
      ? Math.max(0, face.minFacePixels) : 0
  }
  // Earlier scans persisted the weighted quality but not its pixel-size input.
  // Subtract the maximum possible pose contribution to obtain a conservative
  // size lower bound. Never treat high detection confidence alone as detail.
  return 160 * Math.max(0, Math.min(1,
    (face.quality - 0.4 * face.detectorScore - 0.25 * face.descriptorScore - 0.1) / 0.25))
}

/** Produces one-to-one face matches that satisfy the supplied confidence policy. */
function createMatchDecisions(
  state: PeopleTimelineState,
  thresholds: MatchThresholds,
) {
  const profiles = referenceProfiles(state)
  if (!profiles.length) return []

  const confirmedPeople = new Set(
    state.assignments.filter(({ source }) => source === 'manual').map(({ photoKey, personId }) =>
      `${photoKey}\u0000${personId}`,
    ),
  )
  const confirmedFaces = new Set(
    state.assignments.filter(({ source }) => source === 'manual').flatMap(({ photoKey, faceId }) =>
      faceId ? [`${photoKey}\u0000${faceId}`] : [],
    ),
  )
  const dismissed = new Set(
    state.dismissedSuggestions.flatMap(({ photoKey, faceId, personId }) => [
      faceDecisionKey(photoKey, faceId ?? '', personId),
      ...(faceId ? [] : [`${photoKey}\u0000*\u0000${personId}`]),
    ]),
  )
  const decisions: FaceMatchDecision[] = []

  for (const [photoKey, scan] of Object.entries(state.faceScans)) {
    // A manual tag must not remove that identity from the competing evidence:
    // otherwise the same face could be relabelled as its next-closest relative.
    // Suppress confirmed outputs below, while still scoring all people/faces.
    const scoreMatrix: ScoredFace[] = scan.faces.map((detection) => ({
      detection,
      scores: profiles.map(({ personId, references }) => ({
        personId,
        confidence: strongestReferenceSimilarity(detection.embedding, references),
        automaticConfidence: thresholds.automatic
          ? automaticReferenceConfidence(detection.embedding, references, thresholds.minimumSimilarity) : -1,
      })),
    }))

    for (let faceIndex = 0; faceIndex < scoreMatrix.length; faceIndex += 1) {
      const scoredFace = scoreMatrix[faceIndex]
      if (!scoredFace) continue
      const { detection } = scoredFace
      if (confirmedFaces.has(`${photoKey}\u0000${detection.id}`)) continue
      if (![detection.quality, detection.detectorScore, detection.descriptorScore]
        .every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
        detection.quality < thresholds.minimumFaceQuality ||
        detection.detectorScore < (thresholds.automatic ? 0.75 : 0.5) ||
        detection.descriptorScore < (thresholds.automatic ? 0.75 : 0.5) ||
        !clearsMatchThreshold(faceDetailPixels(detection), thresholds.automatic ? 80 : 48)) continue

      const ranked = [...scoredFace.scores]
        .sort((left, right) => right.confidence - left.confidence)

      const best = ranked[0]
      const runnerUp = ranked[1]
      if (best && confirmedPeople.has(`${photoKey}\u0000${best.personId}`)) continue
      const confidence = thresholds.automatic ? best?.automaticConfidence : best?.confidence
      if (!best || confidence === undefined || !clearsMatchThreshold(confidence, qualityAdjustedThreshold(
        thresholds.minimumSimilarity,
        detection.quality,
      ))) continue
      if (
        runnerUp &&
        !clearsMatchThreshold(confidence - runnerUp.confidence, thresholds.minimumFaceMargin)
      ) continue
      if (
        dismissed.has(faceDecisionKey(photoKey, detection.id, best.personId)) ||
        dismissed.has(`${photoKey}\u0000*\u0000${best.personId}`)
      ) continue

      // The chosen identity must be best for this face, and this face must be
      // best for that identity. This one-to-one mutual choice prevents two
      // relatives from collapsing into one person in a group photo.
      const competingFaceScores = scoreMatrix
        .map((faceScores, competingIndex) => competingIndex === faceIndex
          ? -1
          : faceScores.scores.find(({ personId }) => personId === best.personId)
            ?.confidence ?? -1)
        .sort((left, right) => right - left)
      const closestCompetingFace = competingFaceScores[0] ?? -1
      if (
        closestCompetingFace >= confidence ||
        !clearsMatchThreshold(confidence - closestCompetingFace, thresholds.minimumPersonMargin)
      ) continue

      decisions.push({ photoKey, faceId: detection.id, personId: best.personId, confidence })
    }
  }

  return decisions.sort((left, right) =>
    right.confidence - left.confidence,
  )
}

/** Selects high-confidence automatic people suggestions from stored face scans. */
export function createFaceSuggestions(
  state: PeopleTimelineState,
  minimumSimilarity = DEFAULT_HIGH_SIMILARITY,
  minimumFaceMargin = DEFAULT_HIGH_FACE_MARGIN,
  minimumPersonMargin = DEFAULT_HIGH_PERSON_MARGIN,
): FaceMatchDecision[] {
  return createMatchDecisions(state, {
    minimumSimilarity,
    minimumFaceMargin,
    minimumPersonMargin,
    minimumFaceQuality: MINIMUM_HIGH_FACE_QUALITY,
    automatic: true,
  })
}

/** Offers plausible near-matches for optional review without dismissing weak faces. */
export function createFaceReviewCandidates(
  state: PeopleTimelineState,
  minimumSimilarity = DEFAULT_REVIEW_SIMILARITY,
  minimumFaceMargin = DEFAULT_REVIEW_FACE_MARGIN,
  minimumPersonMargin = DEFAULT_REVIEW_PERSON_MARGIN,
  automaticMatches: readonly FaceMatchDecision[] = createFaceSuggestions(state),
): FaceMatchDecision[] {
  const automaticDecisionKeys = new Set(
    automaticMatches.map(({ photoKey, faceId, personId }) =>
      faceDecisionKey(photoKey, faceId, personId),
    ),
  )
  return createMatchDecisions(state, {
    minimumSimilarity,
    minimumFaceMargin,
    minimumPersonMargin,
    minimumFaceQuality: MINIMUM_REVIEW_FACE_QUALITY,
    automatic: false,
  }).filter(({ photoKey, faceId, personId }) =>
    !automaticDecisionKeys.has(faceDecisionKey(photoKey, faceId, personId)),
  )
}

/** Combines manual assignments with accepted automatic matches for one photo. */
export function effectivePeopleForPhoto(
  state: PeopleTimelineState,
  photoKey: string,
  automaticMatches: readonly (FaceSuggestion & { faceId?: string })[] =
    createFaceSuggestions(state),
) {
  const peopleIds = new Set(state.people.map(({ id }) => id))
  const effective = new Set(
    state.assignments
      .filter((assignment) =>
        assignment.source === 'manual' && assignment.photoKey === photoKey && peopleIds.has(assignment.personId),
      )
      .map(({ personId }) => personId),
  )
  for (const match of automaticMatches) {
    if (
      match.photoKey === photoKey &&
      peopleIds.has(match.personId) &&
      !state.dismissedSuggestions.some((dismissal) =>
        dismissal.photoKey === photoKey &&
        dismissal.personId === match.personId &&
        (
          !dismissal.faceId ||
          !match.faceId ||
          dismissal.faceId === match.faceId
        ),
      )
    ) {
      effective.add(match.personId)
    }
  }

  return state.people
    .map(({ id }) => id)
    .filter((personId) => effective.has(personId))
}
