import type {
  FamilyAccessSnapshot,
  FamilyMembership,
  FamilyOnboardingAdapter,
} from './types'
import { supabaseFamilyOnboardingAdapter } from './supabaseFamilyOnboardingAdapter'

const FAMILIES_KEY = 'kinsphere.dev.families.v1'
const MEMBERSHIPS_KEY = 'kinsphere.dev.family-memberships.v1'

type LocalFamily = {
  id: string
  name: string
  code: string
  ownerId?: string
  memberIds?: string[]
}

/** Reads a local-preview table and treats corrupt or non-object JSON as empty. */
function readStorageRecord<T>(storageKey: string): Record<string, T> {
  if (typeof window === 'undefined') return {}
  try {
    const storedValue: unknown = JSON.parse(
      window.localStorage.getItem(storageKey) ?? '{}',
    )
    return storedValue &&
      typeof storedValue === 'object' &&
      !Array.isArray(storedValue)
      ? (storedValue as Record<string, T>)
      : {}
  } catch {
    return {}
  }
}

/** Replaces one local-preview table atomically from the caller's perspective. */
function writeStorageRecord<T>(
  storageKey: string,
  storageRecord: Record<string, T>,
) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(storageRecord))
}

/** Returns four hexadecimal characters with a deterministic-width fallback. */
function createRandomHexSegment() {
  if (!globalThis.crypto?.getRandomValues) {
    return Math.floor(Math.random() * 0x1_0000)
      .toString(16)
      .padStart(4, '0')
  }

  const bytes = new Uint8Array(2)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/** Builds a human-shareable preview code with enough entropy to avoid collisions. */
function createFamilyCode() {
  return `BUB-${Array.from({ length: 6 }, createRandomHexSegment).join('-')}`.toUpperCase()
}

/** Wraps a membership in the adapter's discriminated access result. */
function createMembershipSnapshot(
  membership: FamilyMembership,
): FamilyAccessSnapshot {
  return { kind: 'member', membership }
}

/** Reconciles legacy family member arrays with the authoritative membership table. */
function collectFamilyMemberIds(
  family: LocalFamily,
  memberships: Record<string, FamilyMembership>,
) {
  const storedMembershipIds = Object.entries(memberships)
    .filter(([, membership]) => membership.familyId === family.id)
    .map(([memberId]) => memberId)
  return Array.from(
    new Set([...(family.memberIds ?? []), ...storedMembershipIds]),
  )
}

/** Recovers ownership from memberships when older preview records lack ownerId. */
function resolveFamilyOwnerId(
  family: LocalFamily,
  memberships: Record<string, FamilyMembership>,
) {
  return (
    family.ownerId ??
    Object.entries(memberships).find(
      ([, membership]) =>
        membership.familyId === family.id && membership.role === 'owner',
    )?.[0]
  )
}

/**
 * Stores family setup entirely on the current device for development previews.
 * This adapter must never be selected as the production persistence fallback.
 */
export const localFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: true,

  /** Rehydrates current membership and repairs metadata from related records. */
  async loadAccess({ userId }) {
    const memberships = readStorageRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    const membership = memberships[userId]
    if (!membership) return { kind: 'needs-family' }

    const family = Object.values(
      readStorageRecord<LocalFamily>(FAMILIES_KEY),
    ).find(
      (storedFamily) => storedFamily.id === membership.familyId,
    )
    if (!family) return createMembershipSnapshot(membership)

    const familyMemberIds = collectFamilyMemberIds(family, memberships)
    const ownerId = resolveFamilyOwnerId(family, memberships)
    return createMembershipSnapshot({
      ...membership,
      familyName: family.name,
      ownerId,
      memberCount: familyMemberIds.length,
      shareCode: family.code,
    })
  },

  /** Creates both sides of the local family/membership relation. */
  async createFamily({ userId }, familyName) {
    // A family ID needs more than one 16-bit segment: unlike a display code, an
    // ID collision silently joins two local-preview records together.
    const familyId = `dev-family-${Array.from(
      { length: 4 },
      createRandomHexSegment,
    ).join('')}`
    const family: LocalFamily = {
      id: familyId,
      name: familyName,
      code: createFamilyCode(),
      ownerId: userId,
      memberIds: [userId],
    }
    const families = readStorageRecord<LocalFamily>(FAMILIES_KEY)
    families[family.code] = family
    writeStorageRecord(FAMILIES_KEY, families)

    const membership: FamilyMembership = {
      familyId,
      familyName,
      role: 'owner',
      ownerId: userId,
      memberCount: 1,
      shareCode: family.code,
    }
    const memberships = readStorageRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    memberships[userId] = membership
    writeStorageRecord(MEMBERSHIPS_KEY, memberships)
    return createMembershipSnapshot(membership)
  },

  /** Joins by normalized code and refreshes the member count for every member. */
  async joinFamily({ userId }, inviteCode) {
    const families = readStorageRecord<LocalFamily>(FAMILIES_KEY)
    const family = families[inviteCode.trim().toUpperCase()]
    if (!family) {
      throw new Error(
        'That code is not available in this local preview. Create a family in another local account first.',
      )
    }

    const memberships = readStorageRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    const knownMemberIds = collectFamilyMemberIds(family, memberships)
    const memberIds = Array.from(
      new Set([...knownMemberIds, userId]),
    )
    const ownerId = resolveFamilyOwnerId(family, memberships)
    const updatedFamily = { ...family, ownerId, memberIds }
    families[family.code] = updatedFamily
    writeStorageRecord(FAMILIES_KEY, families)

    const membership: FamilyMembership = {
      familyId: family.id,
      familyName: family.name,
      role: 'member',
      ownerId,
      memberCount: memberIds.length,
      shareCode: family.code,
    }
    memberships[userId] = membership
    for (const memberId of memberIds) {
      const existing = memberships[memberId]
      if (!existing) continue
      memberships[memberId] = {
        ...existing,
        ownerId,
        memberCount: memberIds.length,
        shareCode: family.code,
      }
    }
    writeStorageRecord(MEMBERSHIPS_KEY, memberships)
    return createMembershipSnapshot(membership)
  },
}

/** Explicitly reports that persistent family setup is unavailable. */
export const unavailableFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: false,
  async loadAccess() {
    return { kind: 'needs-family' }
  },
  async createFamily() {
    throw new Error('Family onboarding is not connected.')
  },
  async joinFamily() {
    throw new Error('Family onboarding is not connected.')
  },
}

/** Uses Supabase when configured and otherwise fails closed. */
export const defaultFamilyOnboardingAdapter =
  supabaseFamilyOnboardingAdapter.configured
    ? supabaseFamilyOnboardingAdapter
    : unavailableFamilyOnboardingAdapter
