import { describe, expect, it, vi } from 'vitest'
import {
  MAX_VOICE_NOTE_DURATION_MS,
  startVoiceNoteRecording,
} from './voiceNoteRecorder'

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'

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
    expect(trackStop).toHaveBeenCalled()
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
})
