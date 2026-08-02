import type {
  FamilyAccessSnapshot,
  FamilyMembership,
  FamilyOnboardingAdapter,
} from './types'
import { supabaseFamilyOnboardingAdapter } from './supabaseFamilyOnboardingAdapter'

const FAMILIES_KEY = 'kinsphere.dev.families.v1'
const MEMBERSHIPS_KEY = 'kinsphere.dev.family-memberships.v1'
const TUTORIALS_KEY = 'kinsphere.dev.tutorials.v1'

type LocalFamily = {
  id: string
  name: string
  code: string
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
  const bytes = new Uint8Array(3)
  globalThis.crypto?.getRandomValues?.(bytes)
  const generated = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
  return generated || Math.random().toString(16).slice(2, 8).padEnd(6, '0')
}

function membershipSnapshot(membership: FamilyMembership): FamilyAccessSnapshot {
  return { kind: 'member', membership }
}

export const localFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: true,

  async readTutorial({ userId }) {
    return readRecord<boolean>(TUTORIALS_KEY)[userId] === true
  },

  async completeTutorial({ userId }) {
    const tutorials = readRecord<boolean>(TUTORIALS_KEY)
    tutorials[userId] = true
    writeRecord(TUTORIALS_KEY, tutorials)
  },

  async loadAccess({ userId }) {
    const memberships = readRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    const membership = memberships[userId]
    return membership ? membershipSnapshot(membership) : { kind: 'needs-family' }
  },

  async createFamily({ userId }, familyName) {
    const id = `dev-family-${randomSegment()}`
    const family: LocalFamily = {
      id,
      name: familyName,
      code: `KS-${randomSegment().toUpperCase()}`,
    }
    const families = readRecord<LocalFamily>(FAMILIES_KEY)
    families[family.code] = family
    writeRecord(FAMILIES_KEY, families)

    const membership: FamilyMembership = {
      familyId: id,
      familyName,
      role: 'owner',
    }
    const memberships = readRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    memberships[userId] = membership
    writeRecord(MEMBERSHIPS_KEY, memberships)
    return membershipSnapshot(membership)
  },

  async joinFamily({ userId }, inviteCode) {
    const families = readRecord<LocalFamily>(FAMILIES_KEY)
    const family = families[inviteCode]
    if (!family) {
      throw new Error(
        'That code is not available in this local preview. Create a family in another local account first.',
      )
    }

    const membership: FamilyMembership = {
      familyId: family.id,
      familyName: family.name,
      role: 'member',
    }
    const memberships = readRecord<FamilyMembership>(MEMBERSHIPS_KEY)
    memberships[userId] = membership
    writeRecord(MEMBERSHIPS_KEY, memberships)
    return membershipSnapshot(membership)
  },
}

export const unavailableFamilyOnboardingAdapter: FamilyOnboardingAdapter = {
  configured: false,
  async readTutorial() {
    return false
  },
  async completeTutorial() {
    throw new Error('Family onboarding is not connected.')
  },
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
