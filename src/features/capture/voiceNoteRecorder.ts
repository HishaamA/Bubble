export const MAX_VOICE_NOTE_DURATION_MS = 60_000

export type RecordedVoiceNote = {
  blob: Blob
  mimeType: string
  durationMs: number
}

export type VoiceNoteRecordingSession = {
  stop: () => void
  cancel: () => void
  dispose: () => void
}

type MediaRecorderConstructor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder
  isTypeSupported?: (mimeType: string) => boolean
}

type VoiceNoteVisibilityTarget = EventTarget & {
  visibilityState?: DocumentVisibilityState
}

type VoiceNoteRecorderCallbacks = {
  onComplete: (recording: RecordedVoiceNote) => void
  onError: (message: string) => void
}

type VoiceNoteRecorderDependencies = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  MediaRecorderClass?: MediaRecorderConstructor
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void
  visibilityTarget?: VoiceNoteVisibilityTarget | null
  pageLifecycleTarget?: EventTarget | null
}

const VOICE_NOTE_MIME_TYPE_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const

const BACKEND_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
])

function normalizedBackendAudioMimeType(value: string | undefined) {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return BACKEND_AUDIO_MIME_TYPES.has(normalized) ? normalized : null
}

function preferredVoiceNoteMimeType(
  MediaRecorderClass: MediaRecorderConstructor | undefined,
) {
  if (typeof MediaRecorderClass?.isTypeSupported !== 'function') return null
  return VOICE_NOTE_MIME_TYPE_CANDIDATES.find((mimeType) =>
    MediaRecorderClass.isTypeSupported?.(mimeType)) ?? null
}

function browserRecordingApis() {
  const browserNavigator = typeof navigator === 'undefined'
    ? undefined
    : navigator as unknown as {
      mediaDevices?: {
        getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
      }
    }
  const browserGlobal = globalThis as typeof globalThis & {
    MediaRecorder?: MediaRecorderConstructor
  }

  const mediaDevices = browserNavigator?.mediaDevices

  return {
    getUserMedia: mediaDevices?.getUserMedia?.bind(mediaDevices),
    MediaRecorderClass: browserGlobal.MediaRecorder,
  }
}

export function isVoiceNoteRecordingSupported() {
  const { getUserMedia, MediaRecorderClass } = browserRecordingApis()
  const canSelectCompatibleFormat =
    typeof MediaRecorderClass?.isTypeSupported !== 'function' ||
    Boolean(preferredVoiceNoteMimeType(MediaRecorderClass))
  return Boolean(
    typeof getUserMedia === 'function' &&
      typeof MediaRecorderClass === 'function' &&
      canSelectCompatibleFormat,
  )
}

export async function startVoiceNoteRecording(
  callbacks: VoiceNoteRecorderCallbacks,
  dependencies: VoiceNoteRecorderDependencies = {},
): Promise<VoiceNoteRecordingSession> {
  const browserApis = browserRecordingApis()
  const getUserMedia = dependencies.getUserMedia ?? browserApis.getUserMedia
  const MediaRecorderClass = dependencies.MediaRecorderClass ??
    browserApis.MediaRecorderClass

  if (!getUserMedia || !MediaRecorderClass) {
    throw new Error('Voice recording is not available on this device.')
  }

  const supportsMimeSelection =
    typeof MediaRecorderClass.isTypeSupported === 'function'
  const requestedMimeType = preferredVoiceNoteMimeType(MediaRecorderClass)
  if (supportsMimeSelection && !requestedMimeType) {
    throw new Error(
      'Voice recording is unavailable because this device has no compatible audio format.',
    )
  }

  const now = dependencies.now ?? Date.now
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout
  const visibilityTarget = dependencies.visibilityTarget === undefined
    ? typeof document === 'undefined' ? null : document
    : dependencies.visibilityTarget
  const pageLifecycleTarget = dependencies.pageLifecycleTarget === undefined
    ? typeof window === 'undefined' ? null : window
    : dependencies.pageLifecycleTarget
  const stream = await getUserMedia({ audio: true })
  let recorder: MediaRecorder

  try {
    recorder = requestedMimeType
      ? new MediaRecorderClass(stream, { mimeType: requestedMimeType })
      : new MediaRecorderClass(stream)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    throw error
  }

  const chunks: Blob[] = []
  const startedAt = now()
  let cancelled = false
  let finished = false
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined

  const stopTracks = () => {
    stream.getTracks().forEach((track) => track.stop())
  }

  const stopForBackground = () => stop()
  const stopWhenHidden = () => {
    if (visibilityTarget?.visibilityState === 'hidden') stop()
  }

  const removeLifecycleListeners = () => {
    visibilityTarget?.removeEventListener('visibilitychange', stopWhenHidden)
    pageLifecycleTarget?.removeEventListener('pagehide', stopForBackground)
    pageLifecycleTarget?.removeEventListener('freeze', stopForBackground)
  }

  const clearLimitTimer = () => {
    if (timer === undefined) return
    cancelTimeout(timer)
    timer = undefined
  }

  const settleFailure = (message: string) => {
    if (finished) return
    finished = true
    clearLimitTimer()
    removeLifecycleListeners()
    stopTracks()
    if (!cancelled) callbacks.onError(message)
  }

  const finish = () => {
    if (finished) return
    clearLimitTimer()
    removeLifecycleListeners()
    stopTracks()
    if (cancelled) {
      finished = true
      return
    }

    const declaredMimeTypes = [
      recorder.mimeType,
      ...chunks.map((chunk) => chunk.type),
    ].filter(Boolean)
    if (
      declaredMimeTypes.some((mimeType) =>
        !normalizedBackendAudioMimeType(mimeType))
    ) {
      settleFailure(
        'The recorded audio format is not supported. Please record the voice note again.',
      )
      return
    }

    const mimeType =
      normalizedBackendAudioMimeType(recorder.mimeType) ??
      normalizedBackendAudioMimeType(chunks[0]?.type) ??
      normalizedBackendAudioMimeType(requestedMimeType ?? undefined)
    if (!mimeType) {
      settleFailure(
        'The recorded audio format is not supported. Please record the voice note again.',
      )
      return
    }

    const blob = new Blob(chunks, { type: mimeType })
    if (blob.size === 0) {
      settleFailure('The voice note was empty. Please record it again.')
      return
    }

    finished = true
    callbacks.onComplete({
      blob,
      mimeType,
      durationMs: Math.min(
        MAX_VOICE_NOTE_DURATION_MS,
        Math.max(0, now() - startedAt),
      ),
    })
  }

  const fail = () => {
    settleFailure('The voice note could not be recorded. Please try again.')
  }

  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (!cancelled && event.data.size > 0) chunks.push(event.data)
  })
  recorder.addEventListener('stop', finish, { once: true })
  recorder.addEventListener('error', fail, { once: true })

  function stop() {
    if (finished) return
    clearLimitTimer()
    if (recorder.state === 'inactive') {
      finish()
      return
    }
    try {
      recorder.stop()
      stopTracks()
    } catch {
      fail()
    }
  }

  function cancel() {
    if (finished) return
    cancelled = true
    stop()
  }

  const session: VoiceNoteRecordingSession = {
    stop,
    cancel,
    dispose: cancel,
  }

  try {
    recorder.start()
    visibilityTarget?.addEventListener('visibilitychange', stopWhenHidden)
    pageLifecycleTarget?.addEventListener('pagehide', stopForBackground)
    pageLifecycleTarget?.addEventListener('freeze', stopForBackground)
    timer = scheduleTimeout(stop, MAX_VOICE_NOTE_DURATION_MS)
  } catch (error) {
    cancelled = true
    clearLimitTimer()
    removeLifecycleListeners()
    stopTracks()
    throw error
  }

  return session
}
