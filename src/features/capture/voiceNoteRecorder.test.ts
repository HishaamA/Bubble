import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_VOICE_NOTE_DURATION_MS,
  startVoiceNoteRecording,
} from './voiceNoteRecorder'

class FakeMediaRecorder extends EventTarget {
  static supportedMimeTypes = new Set(['audio/webm;codecs=opus'])
  static requestedMimeTypes: string[] = []

  static isTypeSupported(mimeType: string) {
    return FakeMediaRecorder.supportedMimeTypes.has(mimeType)
  }

  state: RecordingState = 'inactive'
  mimeType: string

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super()
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.requestedMimeTypes.push(this.mimeType)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    const dataEvent = new Event('dataavailable')
    Object.defineProperty(dataEvent, 'data', {
      value: new Blob(['voice sample'], { type: this.mimeType }),
    })
    this.dispatchEvent(dataEvent)
    this.dispatchEvent(new Event('stop'))
  }
}

function recorderDependencies(now: () => number) {
  const trackStop = vi.fn()
  const stream = {
    getTracks: () => [{ stop: trackStop }],
  } as unknown as MediaStream
  let limit: (() => void) | undefined

  return {
    trackStop,
    runLimit: () => limit?.(),
    dependencies: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      MediaRecorderClass: FakeMediaRecorder as unknown as typeof MediaRecorder,
      now,
      setTimeout: (callback: () => void) => {
        limit = callback
        return 1 as unknown as ReturnType<typeof globalThis.setTimeout>
      },
      clearTimeout: vi.fn(),
    },
  }
}

describe('voiceNoteRecorder', () => {
  beforeEach(() => {
    FakeMediaRecorder.supportedMimeTypes = new Set(['audio/webm;codecs=opus'])
    FakeMediaRecorder.requestedMimeTypes = []
  })

  it('stops automatically at 60 seconds and returns the captured audio', async () => {
    let now = 1_000
    const { dependencies, runLimit, trackStop } = recorderDependencies(() => now)
    const onComplete = vi.fn()
    const onError = vi.fn()

    await startVoiceNoteRecording(
      { onComplete, onError },
      dependencies,
    )
    now += MAX_VOICE_NOTE_DURATION_MS + 5_000
    runLimit()

    expect(onError).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      blob: expect.any(Blob),
      mimeType: 'audio/webm',
      durationMs: MAX_VOICE_NOTE_DURATION_MS,
    }))
    expect(FakeMediaRecorder.requestedMimeTypes).toEqual([
      'audio/webm;codecs=opus',
    ])
    expect(trackStop).toHaveBeenCalled()
  })

  it('prefers MP4/AAC over WebM/Opus and returns a backend MIME type', async () => {
    FakeMediaRecorder.supportedMimeTypes = new Set([
      'audio/mp4;codecs=mp4a.40.2',
      'audio/webm;codecs=opus',
    ])
    const { dependencies } = recorderDependencies(() => 2_000)
    const onComplete = vi.fn()
    const session = await startVoiceNoteRecording(
      { onComplete, onError: vi.fn() },
      dependencies,
    )

    session.stop()

    expect(FakeMediaRecorder.requestedMimeTypes).toEqual([
      'audio/mp4;codecs=mp4a.40.2',
    ])
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'audio/mp4',
      blob: expect.objectContaining({ type: 'audio/mp4' }),
    }))
  })

  it('uses the recorder default when MIME feature detection is unavailable', async () => {
    class LegacyMediaRecorder extends EventTarget {
      state: RecordingState = 'inactive'
      mimeType = 'audio/webm;codecs=opus'

      constructor(_stream: MediaStream) {
        super()
      }

      start() {
        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        const dataEvent = new Event('dataavailable')
        Object.defineProperty(dataEvent, 'data', {
          value: new Blob(['voice sample'], { type: this.mimeType }),
        })
        this.dispatchEvent(dataEvent)
        this.dispatchEvent(new Event('stop'))
      }
    }
    const { dependencies } = recorderDependencies(() => 2_000)
    const onComplete = vi.fn()
    const session = await startVoiceNoteRecording(
      { onComplete, onError: vi.fn() },
      {
        ...dependencies,
        MediaRecorderClass: LegacyMediaRecorder as unknown as typeof MediaRecorder,
      },
    )

    session.stop()

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'audio/webm',
    }))
  })

  it('stops every microphone track and emits nothing when cancelled', async () => {
    const firstTrackStop = vi.fn()
    const secondTrackStop = vi.fn()
    const stream = {
      getTracks: () => [
        { stop: firstTrackStop },
        { stop: secondTrackStop },
      ],
    } as unknown as MediaStream
    const onComplete = vi.fn()

    const session = await startVoiceNoteRecording(
      { onComplete, onError: vi.fn() },
      {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        MediaRecorderClass: FakeMediaRecorder as unknown as typeof MediaRecorder,
      },
    )
    session.cancel()

    expect(onComplete).not.toHaveBeenCalled()
    expect(firstTrackStop).toHaveBeenCalled()
    expect(secondTrackStop).toHaveBeenCalled()
  })

  it('reports unsupported browsers before requesting a microphone', async () => {
    await expect(
      startVoiceNoteRecording(
        { onComplete: vi.fn(), onError: vi.fn() },
        {
          getUserMedia: undefined,
          MediaRecorderClass: undefined,
        },
      ),
    ).rejects.toThrow(/not available/i)
  })

  it('rejects devices with no backend-compatible recorder format', async () => {
    class UnsupportedMediaRecorder extends FakeMediaRecorder {
      static override isTypeSupported() {
        return false
      }
    }
    const getUserMedia = vi.fn()

    await expect(
      startVoiceNoteRecording(
        { onComplete: vi.fn(), onError: vi.fn() },
        {
          getUserMedia,
          MediaRecorderClass:
            UnsupportedMediaRecorder as unknown as typeof MediaRecorder,
        },
      ),
    ).rejects.toThrow(/compatible audio format/i)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('rejects an empty recording instead of returning an uploadable clip', async () => {
    class EmptyMediaRecorder extends FakeMediaRecorder {
      override stop() {
        this.state = 'inactive'
        const dataEvent = new Event('dataavailable')
        Object.defineProperty(dataEvent, 'data', {
          value: new Blob([], { type: this.mimeType }),
        })
        this.dispatchEvent(dataEvent)
        this.dispatchEvent(new Event('stop'))
      }
    }
    const { dependencies } = recorderDependencies(() => 2_000)
    const onComplete = vi.fn()
    const onError = vi.fn()
    const session = await startVoiceNoteRecording(
      { onComplete, onError },
      {
        ...dependencies,
        MediaRecorderClass: EmptyMediaRecorder as unknown as typeof MediaRecorder,
      },
    )

    session.stop()

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'The voice note was empty. Please record it again.',
    )
  })

  it('rejects audio chunks whose declared format is unsupported', async () => {
    class UnsupportedOutputMediaRecorder extends FakeMediaRecorder {
      override stop() {
        this.state = 'inactive'
        const dataEvent = new Event('dataavailable')
        Object.defineProperty(dataEvent, 'data', {
          value: new Blob(['voice sample'], { type: 'audio/ogg' }),
        })
        this.dispatchEvent(dataEvent)
        this.dispatchEvent(new Event('stop'))
      }
    }
    const { dependencies } = recorderDependencies(() => 2_000)
    const onComplete = vi.fn()
    const onError = vi.fn()
    const session = await startVoiceNoteRecording(
      { onComplete, onError },
      {
        ...dependencies,
        MediaRecorderClass:
          UnsupportedOutputMediaRecorder as unknown as typeof MediaRecorder,
      },
    )

    session.stop()

    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/not supported/i))
  })

  it('stops recording when the page lifecycle moves to the background', async () => {
    const pageLifecycleTarget = new EventTarget()
    const { dependencies, trackStop } = recorderDependencies(() => 2_000)
    const onComplete = vi.fn()
    await startVoiceNoteRecording(
      { onComplete, onError: vi.fn() },
      { ...dependencies, pageLifecycleTarget, visibilityTarget: null },
    )

    pageLifecycleTarget.dispatchEvent(new Event('pagehide'))

    expect(onComplete).toHaveBeenCalledOnce()
    expect(trackStop).toHaveBeenCalled()
  })

  it('does not infer a hidden page from a lifecycle fake with no state', async () => {
    const visibilityTarget = new EventTarget()
    const { dependencies } = recorderDependencies(() => 2_000)
    const onComplete = vi.fn()
    const session = await startVoiceNoteRecording(
      { onComplete, onError: vi.fn() },
      {
        ...dependencies,
        visibilityTarget,
        pageLifecycleTarget: null,
      },
    )

    visibilityTarget.dispatchEvent(new Event('visibilitychange'))
    expect(onComplete).not.toHaveBeenCalled()

    session.stop()
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
