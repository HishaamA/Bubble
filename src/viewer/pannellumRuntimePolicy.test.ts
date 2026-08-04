/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const runtimeSource = readFileSync(
  resolve(process.cwd(), 'public/vendor/pannellum/pannellum.js'),
  'utf8',
)

describe('bundled Pannellum phone motion policy', () => {
  it('accepts standards-secure and native app contexts without a mobile UA guess', () => {
    expect(runtimeSource).toContain(
      'E.isSecureContext||"capacitor:"==location.protocol||"ionic:"==location.protocol',
    )
    expect(runtimeSource).not.toContain(
      '"https:"==location.protocol&&0<=navigator.userAgent.toLowerCase().indexOf("mobi")',
    )
  })

  it('leaves permission ownership to the adapter user gesture', () => {
    expect(runtimeSource).not.toContain(
      'DeviceOrientationEvent.requestPermission().then',
    )
    expect(runtimeSource).toContain(
      'function Ra(){X=1;E.addEventListener("deviceorientation",na)',
    )
  })
})
