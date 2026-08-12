export function eventStorageKey(baseKey: string, subject: string) {
  return `${baseKey}:${encodeURIComponent(subject.trim() || 'signed-out')}`
}
