import { describe, expect, it } from 'vitest'
import {
  FACE_INFERENCE_LONG_EDGE,
  FACE_NATIVE_DECODE_LONG_EDGE,
  FACE_RES_DESCRIPTOR_LENGTH,
  HUMAN_MODEL_BASE_PATH,
  TFJS_WASM_ASSET_PATH,
  TFJS_WASM_VERSION,
  FacePhotoPipelineError,
  createFaceHumanConfig,
  extractFaceDetections,
} from './faceRecognitionPipeline'
import { FACE_MODEL_REVISION, FACE_SCAN_REVISION } from './types'

function embedding(value = 0.5) {
  return Array<number>(FACE_RES_DESCRIPTOR_LENGTH).fill(value)
}

describe('shared FaceRes pipeline', () => {
  it('keeps the existing model and scan revisions unchanged', () => {
    expect(FACE_MODEL_REVISION).toBe('human-3.3.6-faceres-v1')
    expect(FACE_SCAN_REVISION).toBe('human-3.3.6-faceres-rotation-equalized-v2')
    expect(FACE_RES_DESCRIPTOR_LENGTH).toBe(1024)
    expect(FACE_NATIVE_DECODE_LONG_EDGE).toBe(1600)
    expect(FACE_INFERENCE_LONG_EDGE).toBe(1280)
  })

  it('uses one identical model and preprocessing configuration for every backend', () => {
    const webgl = createFaceHumanConfig('webgl')
    const wasm = createFaceHumanConfig('wasm')
    const cpu = createFaceHumanConfig('cpu')
    const withoutBackend = (config: typeof webgl) => {
      const { backend: _backend, wasmPath: _wasmPath,
        wasmPlatformFetch: _wasmPlatformFetch, ...shared } = config
      return shared
    }

    expect(withoutBackend(wasm)).toEqual(withoutBackend(webgl))
    expect(withoutBackend(cpu)).toEqual(withoutBackend(webgl))
    expect(webgl).toMatchObject({
      modelBasePath: HUMAN_MODEL_BASE_PATH,
      cacheSensitivity: 0,
      skipAllowed: false,
      filter: { equalization: true, width: 0, height: 0 },
      face: {
        detector: {
          modelPath: 'blazeface.json',
          rotation: true,
          maxDetected: 20,
          minConfidence: 0.28,
          minSize: 20,
          skipFrames: 0,
          skipTime: 0,
        },
        mesh: { modelPath: 'facemesh.json', keepInvalid: false },
        description: {
          modelPath: 'faceres.json',
          minConfidence: 0.45,
          skipFrames: 0,
          skipTime: 0,
        },
      },
    })
    expect(wasm).toMatchObject({
      backend: 'wasm',
      wasmPath: TFJS_WASM_ASSET_PATH,
      wasmPlatformFetch: true,
    })
    expect(TFJS_WASM_VERSION).toBe('4.22.0')
  })

  it('extracts the unchanged normalized geometry, quality, and FaceRes vector', () => {
    const vector = embedding(0.75)
    const result = extractFaceDetections({
      error: null,
      width: 1000,
      height: 500,
      face: [{
        embedding: vector,
        box: [100, 50, 200, 100],
        boxScore: 0.8,
        faceScore: 0.6,
        rotation: { angle: { pitch: 0, yaw: 0, roll: 0 } },
      }],
    } as never, { width: 1280, height: 640 })

    expect(result.detectedFaceCount).toBe(1)
    expect(result.faces[0]).toEqual({
      id: 'face-1',
      embedding: vector,
      box: [0.1, 0.1, 0.2, 0.2],
      detectorScore: 0.8,
      descriptorScore: 0.6,
      quality: 0.7262500000000001,
      minPixelSize: 100,
      minFacePixels: 100,
      maximumPoseAngle: 0,
    })
  })

  it.each([
    undefined,
    Array<number>(1023).fill(1),
    Array<number>(1025).fill(1),
    Array<number>(1024).fill(0),
    [...Array<number>(1023).fill(1), Number.NaN],
  ])('classifies an invalid descriptor as a photo failure', (vector) => {
    expect(() => extractFaceDetections({
      error: null,
      width: 1280,
      height: 720,
      face: [{ embedding: vector }],
    } as never, { width: 1280, height: 720 })).toThrow(FacePhotoPipelineError)
  })
})
