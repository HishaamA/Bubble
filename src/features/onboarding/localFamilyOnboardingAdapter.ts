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

function readRecord<T>(key: string): Record<string, T> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, T>)
      : {}
  } catch {
    return {}
  }
}

function writeRecord<T>(key: string, value: Record<string, T>) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

function randomSegment() {
  const bytes = new Uint8Array(2)
  globalThis.crypto?.getRandomValues?.(bytes)
  const generated = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return generated || Math.random().toString(16).slice(2, 6).padEnd(4, '0')
}

function familyCode() {
  return `BUB-${Array.from({ length: 6 }, randomSegment).join('-')}`.toUpperCase()
}

function membershipSnapshot(membership: FamilyMembership): FamilyAccessSnapshot {
  return { kind: 'member', membership }
}

export const localFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: true,

  async loadAccess({ userId }) {
    const memberships = readRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    const membership = memberships[userId]
    if (!membership) return { kind: 'needs-family' }

    const family = Object.values(readRecord<LocalFamily>(FAMILIES_KEY)).find(
      (candidate) => candidate.id === membership.familyId,
    )
    if (!family) return membershipSnapshot(membership)

    const familyMemberIds = Object.entries(memberships)
      .filter(([, candidate]) => candidate.familyId === family.id)
      .map(([memberId]) => memberId)
    const ownerId =
      family.ownerId ??
      Object.entries(memberships).find(
        ([, candidate]) =>
          candidate.familyId === family.id && candidate.role === 'owner',
      )?.[0]
    return membershipSnapshot({
      ...membership,
      familyName: family.name,
      ownerId,
      memberCount: new Set([...(family.memberIds ?? []), ...familyMemberIds]).size,
      shareCode: family.code,
    })
  },

  async createFamily({ userId }, familyName) {
    const id = `dev-family-${randomSegment()}`
    const family: LocalFamily = {
      id,
      name: familyName,
      code: familyCode(),
      ownerId: userId,
      memberIds: [userId],
    }
    const families = readRecord<LocalFamily>(FAMILIES_KEY)
    families[family.code] = family
    writeRecord(FAMILIES_KEY, families)

    const membership: FamilyMembership = {
      familyId: id,
      familyName,
      role: 'owner',
      ownerId: userId,
      memberCount: 1,
      shareCode: family.code,
    }
    const memberships = readRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    memberships[userId] = membership
    writeRecord(MEMBERSHIPS_KEY, memberships)
    return membershipSnapshot(membership)
  },

  async joinFamily({ userId }, inviteCode) {
    const families = readRecord<LocalFamily>(FAMILIES_KEY)
    const family = families[inviteCode.trim().toUpperCase()]
    if (!family) {
      throw new Error(
        'That code is not available in this local preview. Create a family in another local account first.',
      )
    }

    const memberships = readRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    const knownMemberIds = Object.entries(memberships)
      .filter(([, candidate]) => candidate.familyId === family.id)
      .map(([memberId]) => memberId)
    const memberIds = Array.from(
      new Set([...(family.memberIds ?? []), ...knownMemberIds, userId]),
    )
    const ownerId =
      family.ownerId ??
      Object.entries(memberships).find(
        ([, candidate]) =>
          candidate.familyId === family.id && candidate.role === 'owner',
      )?.[0]
    const updatedFamily = { ...family, ownerId, memberIds }
    families[family.code] = updatedFamily
    writeRecord(FAMILIES_KEY, families)

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
    writeRecord(MEMBERSHIPS_KEY, memberships)
    return membershipSnapshot(membership)
  },
}

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

export const defaultFamilyOnboardingAdapter =
  supabaseFamilyOnboardingAdapter.configured
    ? supabaseFamilyOnboardingAdapter
    : unavailableFamilyOnboardingAdapter
