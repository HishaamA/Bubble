import { describe, expect, it } from 'vitest'
import { isNativeFaceScan } from './nativeGalleryScan'

describe('native background face scan boundary', () => {
  const scan = () => ({ scannedAt: '2026-09-14T00:00:00Z', faces: [{
    id: 'face-1', embedding: Array.from({ length: 1024 }, () => 0.01), box: [0.1, 0.1, 0.5, 0.5],
    detectorScore: 0.9, descriptorScore: 0.9, quality: 0.9, minFacePixels: 120,
  }] })
  it('accepts compatible 1024-dimensional scans and genuinely empty no-face results', () => {
    expect(isNativeFaceScan(scan())).toBe(true)
    expect(isNativeFaceScan({ scannedAt: scan().scannedAt, faces: [] })).toBe(true)
  })
  it('rejects incomplete or malformed descriptors instead of acknowledging them as no-face scans', () => {
    const value = scan()
    value.faces[0].embedding = [1, 2]
    expect(isNativeFaceScan(value)).toBe(false)
    value.faces[0].embedding = Array.from({ length: 1024 }, () => 0)
    expect(isNativeFaceScan(value)).toBe(false)
    value.faces[0].embedding[0] = NaN
    expect(isNativeFaceScan(value)).toBe(false)
  })
  it('rejects unsafe geometry, unknown dates and duplicate face IDs', () => {
    const value = scan()
    value.faces[0].box = [0.9, 0.9, 0.5, 0.5]
    expect(isNativeFaceScan(value)).toBe(false)
    expect(isNativeFaceScan({ ...scan(), scannedAt: 'bad date' })).toBe(false)
    expect(isNativeFaceScan({ ...scan(), faces: [scan().faces[0], scan().faces[0]] })).toBe(false)
  })
})
