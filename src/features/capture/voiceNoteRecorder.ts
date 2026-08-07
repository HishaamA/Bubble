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

type MediaRecorderConstructor = new (stream: MediaStream) => MediaRecorder

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
  return Boolean(
    typeof getUserMedia === 'function' &&
      typeof MediaRecorderClass === 'function',
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

  const now = dependencies.now ?? Date.now
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout
  const stream = await getUserMedia({ audio: true })
  let recorder: MediaRecorder

  try {
    recorder = new MediaRecorderClass(stream)
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

  const clearLimitTimer = () => {
    if (timer === undefined) return
    cancelTimeout(timer)
    timer = undefined
  }

  const finish = () => {
    if (finished) return
    finished = true
    clearLimitTimer()
    stopTracks()
    if (cancelled) return

    const mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm'
    callbacks.onComplete({
      blob: new Blob(chunks, { type: mimeType }),
      mimeType,
      durationMs: Math.min(
        MAX_VOICE_NOTE_DURATION_MS,
        Math.max(0, now() - startedAt),
      ),
    })
  }

  const fail = () => {
    if (finished) return
    finished = true
    clearLimitTimer()
    stopTracks()
    if (!cancelled) {
      callbacks.onError('The voice note could not be recorded. Please try again.')
    }
  }

  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (!cancelled && event.data.size > 0) chunks.push(event.data)
  })
  recorder.addEventListener('stop', finish, { once: true })
  recorder.addEventListener('error', fail, { once: true })

  const stop = () => {
    if (finished) return
    clearLimitTimer()
    if (recorder.state === 'inactive') {
      finish()
      return
    }
    recorder.stop()
    stopTracks()
  }

  const cancel = () => {
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
    timer = scheduleTimeout(stop, MAX_VOICE_NOTE_DURATION_MS)
  } catch (error) {
    cancelled = true
    clearLimitTimer()
    stopTracks()
    throw error
  }

  return session
}
