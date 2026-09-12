/** Profile metadata must never become a script, local file, or credentialed URL. */
export function capsuleContributorAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

/** A stable, compact credit when a contributor has no available profile photo. */
export function capsuleContributorInitials(name: string) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => Array.from(part)[0]).join('').toUpperCase() || '♡'
}
