/** Appends an encoded account/family subject to an event storage key. */
export function eventStorageKey(baseKey: string, subject: string) {
  return `${baseKey}:${encodeURIComponent(subject.trim() || 'signed-out')}`
}

/** Keeps local plans and reminder registries isolated across family changes. */
export function familyEventStorageSubject(
  userId: string | null | undefined,
  familyId: string | null | undefined,
) {
  const account = userId?.trim() || 'signed-out'
  const family = familyId?.trim() || 'no-family'
  return `${account}:family:${family}`
}
