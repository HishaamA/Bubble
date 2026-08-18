import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { PanoramaOrientationStartOptions, PanoramaScene } from '../../../viewer'
import {
  deviceOrientationQuaternion,
  evenPixelWidth,
  quaternionToMatrix3,
  relativeDeviceViewQuaternion,
  resolveStereoViewports,
  viewQuaternion,
  type Quaternion,
} from './stereoPanoramaMath'
import './StereoPanoramaRenderer.css'

export interface StereoPanoramaRendererHandle {
  startOrientation: (options?: PanoramaOrientationStartOptions) => Promise<boolean>
  stopOrientation: () => void
  resize: () => void
}

export interface StereoPanoramaRendererProps {
  scene: PanoramaScene
  ariaLabel: string
  /** Fraction of each eye width; positive values move both centers inward. */
  opticalCenterShift?: number
  onReady?: () => void
  onError?: (error: Error) => void
}

type RendererStatus = 'loading' | 'ready' | 'fallback' | 'error'

type PendingOrientationStart = {
  settle: (started: boolean) => void
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vPosition;
void main() {
  vPosition = aPosition;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vPosition;
uniform sampler2D uPanorama;
uniform mat3 uCameraRotation;
uniform float uEyeAspect;
uniform float uTanHalfHorizontalFov;
uniform float uOpticalCenter;
const float PI = 3.1415926535897932384626433832795;
void main() {
  // A fourth-power superellipse gives each half the soft rectangular lens
  // silhouette used by Cardboard viewers while preserving a generous field of
  // view. The single shader/canvas still drives both eyes in the same frame.
  float lensDistance = pow(abs(vPosition.x), 4.0) + pow(abs(vPosition.y), 4.0);
  float lensMask = 1.0 - smoothstep(0.985, 1.015, lensDistance);
  vec2 centered = vec2(vPosition.x - uOpticalCenter, vPosition.y);
  vec3 cameraRay = normalize(vec3(
    centered.x * uTanHalfHorizontalFov,
    centered.y * uTanHalfHorizontalFov / uEyeAspect,
    -1.0
  ));
  vec3 worldRay = normalize(uCameraRotation * cameraRay);
  float yaw = atan(worldRay.x, -worldRay.z);
  float pitch = asin(clamp(worldRay.y, -1.0, 1.0));
  vec2 uv = vec2(fract(0.5 + yaw / (2.0 * PI)), 0.5 - pitch / PI);
  vec4 panorama = texture2D(uPanorama, uv);
  float edgeShade = 1.0 - 0.38 * smoothstep(0.80, 1.0, lensDistance);
  gl_FragColor = vec4(panorama.rgb * edgeShade * lensMask, 1.0);
}`

interface ShaderLocations {
  position: number
  panorama: WebGLUniformLocation
  cameraRotation: WebGLUniformLocation
  eyeAspect: WebGLUniformLocation
  tanHalfHorizontalFov: WebGLUniformLocation
  opticalCenter: WebGLUniformLocation
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('The panorama shader could not be created.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader error.'
    gl.deleteShader(shader)
    throw new Error(`The panorama shader could not compile: ${message}`)
  }
  return shader
}

function requiredUniform(gl: WebGLRenderingContext, program: WebGLProgram, name: string) {
  const location = gl.getUniformLocation(program, name)
  if (!location) throw new Error(`The panorama shader is missing ${name}.`)
  return location
}

export class StereoWebGlPanoramaRenderer {
  readonly gl: WebGLRenderingContext
  private readonly canvas: HTMLCanvasElement
  private readonly program: WebGLProgram
  private readonly vertexShader: WebGLShader
  private readonly fragmentShader: WebGLShader
  private readonly quadBuffer: WebGLBuffer
  private readonly texture: WebGLTexture
  private readonly locations: ShaderLocations
  private textureReady = false
  private destroyed = false

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL is unavailable on this device.')
    this.gl = gl
    this.canvas = canvas
    this.vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    this.fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    const program = gl.createProgram()
    if (!program) throw new Error('The panorama program could not be created.')
    this.program = program
    gl.attachShader(program, this.vertexShader)
    gl.attachShader(program, this.fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`The panorama program could not link: ${gl.getProgramInfoLog(program) || 'Unknown WebGL error.'}`)
    }
    const quadBuffer = gl.createBuffer()
    const texture = gl.createTexture()
    if (!quadBuffer || !texture) throw new Error('The panorama GPU resources could not be created.')
    this.quadBuffer = quadBuffer
    this.texture = texture
    this.locations = {
      position: gl.getAttribLocation(program, 'aPosition'),
      panorama: requiredUniform(gl, program, 'uPanorama'),
      cameraRotation: requiredUniform(gl, program, 'uCameraRotation'),
      eyeAspect: requiredUniform(gl, program, 'uEyeAspect'),
      tanHalfHorizontalFov: requiredUniform(gl, program, 'uTanHalfHorizontalFov'),
      opticalCenter: requiredUniform(gl, program, 'uOpticalCenter'),
    }
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(this.locations.position)
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.uniform1i(this.locations.panorama, 0)
    gl.clearColor(0, 0, 0, 1)
  }

  uploadPanorama(image: HTMLImageElement) {
    if (this.destroyed) return
    const { gl } = this
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    this.textureReady = true
  }

  resize() {
    if (this.destroyed) return
    const bounds = this.canvas.getBoundingClientRect()
    // A portrait fallback rotates an outer element. clientWidth/clientHeight
    // preserve the canvas's pre-transform landscape layout, while the bounding
    // rectangle swaps those axes after the 90° transform.
    const cssWidth = this.canvas.clientWidth || bounds.width
    const cssHeight = this.canvas.clientHeight || bounds.height
    if (cssWidth <= 0 || cssHeight <= 0) return
    const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
    const width = evenPixelWidth(cssWidth * pixelRatio)
    const height = Math.max(1, Math.round(cssHeight * pixelRatio))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
  }

  render(cameraRotation: Float32Array, horizontalFovDegrees: number, opticalCenterShift: number) {
    if (this.destroyed || !this.textureReady) return
    // ResizeObserver and the native orientation settle timers own measurement;
    // never force layout from the animation loop once the buffer has dimensions.
    if (this.canvas.width < 2 || this.canvas.height < 1) this.resize()
    const { gl, canvas } = this
    const eyes = resolveStereoViewports(
      canvas.width,
      canvas.height,
      opticalCenterShift,
    )
    const eyeAspect = eyes[0].width / Math.max(eyes[0].height, 1)
    const hfov = Math.max(55, Math.min(110, horizontalFovDegrees))
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniformMatrix3fv(this.locations.cameraRotation, false, cameraRotation)
    gl.uniform1f(this.locations.eyeAspect, eyeAspect)
    gl.uniform1f(this.locations.tanHalfHorizontalFov, Math.tan((hfov * Math.PI) / 360))
    gl.clear(gl.COLOR_BUFFER_BIT)
    eyes.forEach((eye) => {
      gl.viewport(eye.x, eye.y, eye.width, eye.height)
      gl.uniform1f(this.locations.opticalCenter, eye.opticalCenter)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    })
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    const { gl } = this
    gl.deleteTexture(this.texture)
    gl.deleteBuffer(this.quadBuffer)
    gl.deleteProgram(this.program)
    gl.deleteShader(this.vertexShader)
    gl.deleteShader(this.fragmentShader)
  }
}

function screenOrientationAngle() {
  const angle = globalThis.screen?.orientation?.angle
  if (typeof angle === 'number') return angle
  const legacy = (window as Window & { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

function needsAnonymousCors(source: string) {
  try {
    const url = new URL(source, window.location.href)
    return url.protocol.startsWith('http') && url.origin !== window.location.origin
  } catch {
    return false
  }
}

export const StereoPanoramaRenderer = forwardRef<
  StereoPanoramaRendererHandle,
  StereoPanoramaRendererProps
>(function StereoPanoramaRenderer(
  { scene, ariaLabel, opticalCenterShift = 0, onReady, onError },
  forwardedRef,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<StereoWebGlPanoramaRenderer | null>(null)
  const callbacksRef = useRef({ onReady, onError })
  const frameRef = useRef<number | null>(null)
  const requestRef = useRef(0)
  const orientationActiveRef = useRef(false)
  const orientationListenerRef = useRef<((event: DeviceOrientationEvent) => void) | null>(null)
  const pendingOrientationRef = useRef<PendingOrientationStart | null>(null)
  const initialDeviceRef = useRef<Quaternion | null>(null)
  const currentDeviceRef = useRef<Quaternion | null>(null)
  const manualRef = useRef({ yaw: scene.yaw ?? 0, pitch: scene.pitch ?? 0 })
  const sceneViewRef = useRef({ yaw: scene.yaw ?? 0, pitch: scene.pitch ?? 0, hfov: scene.hfov ?? 92 })
  const centerShiftRef = useRef(opticalCenterShift)
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const [status, setStatus] = useState<RendererStatus>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => { callbacksRef.current = { onReady, onError } }, [onError, onReady])
  useEffect(() => { centerShiftRef.current = opticalCenterShift }, [opticalCenterShift])
  useEffect(() => {
    sceneViewRef.current = { yaw: scene.yaw ?? 0, pitch: scene.pitch ?? 0, hfov: scene.hfov ?? 92 }
    manualRef.current = { yaw: scene.yaw ?? 0, pitch: scene.pitch ?? 0 }
    initialDeviceRef.current = null
    currentDeviceRef.current = null
  }, [scene.id, scene.hfov, scene.pitch, scene.yaw])

  const stopOrientation = useCallback(() => {
    pendingOrientationRef.current?.settle(false)
    pendingOrientationRef.current = null
    const listener = orientationListenerRef.current
    if (listener) window.removeEventListener('deviceorientation', listener)
    orientationListenerRef.current = null
    orientationActiveRef.current = false
    initialDeviceRef.current = null
    currentDeviceRef.current = null
  }, [])

  const startOrientation = useCallback(async (_options?: PanoramaOrientationStartOptions) => {
    if (!rendererRef.current || typeof globalThis.DeviceOrientationEvent === 'undefined') return false
    stopOrientation()
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timeout = 0
      const listener = (event: DeviceOrientationEvent) => {
        if (event.alpha === null || event.beta === null || event.gamma === null) return
        const sample = deviceOrientationQuaternion(
          event.alpha,
          event.beta,
          event.gamma,
          screenOrientationAngle(),
        )
        initialDeviceRef.current ??= sample
        currentDeviceRef.current = sample
        orientationActiveRef.current = true
        settle(true)
      }
      const settle = (started: boolean) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        if (pendingOrientationRef.current?.settle === settle) {
          pendingOrientationRef.current = null
        }
        if (!started) {
          window.removeEventListener('deviceorientation', listener)
          if (orientationListenerRef.current === listener) {
            orientationListenerRef.current = null
          }
          orientationActiveRef.current = false
          initialDeviceRef.current = null
          currentDeviceRef.current = null
        }
        resolve(started)
      }

      orientationListenerRef.current = listener
      pendingOrientationRef.current = { settle }
      window.addEventListener('deviceorientation', listener)
      timeout = window.setTimeout(() => settle(false), 1500)
    })
  }, [stopOrientation])

  useImperativeHandle(forwardedRef, () => ({
    startOrientation,
    stopOrientation,
    resize: () => rendererRef.current?.resize(),
  }), [startOrientation, stopOrientation])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      rendererRef.current = new StereoWebGlPanoramaRenderer(canvas)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error('WebGL could not start.')
      setStatus('fallback')
      setErrorMessage(normalized.message)
      callbacksRef.current.onError?.(normalized)
      return
    }
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => rendererRef.current?.resize())
    observer?.observe(canvas)
    rendererRef.current.resize()

    const draw = () => {
      const renderer = rendererRef.current
      if (!renderer) return
      const view = sceneViewRef.current
      const first = initialDeviceRef.current
      const current = currentDeviceRef.current
      const pose = orientationActiveRef.current && first && current
        ? relativeDeviceViewQuaternion(viewQuaternion(view.yaw, view.pitch), first, current)
        : viewQuaternion(manualRef.current.yaw, manualRef.current.pitch)
      renderer.render(quaternionToMatrix3(pose), view.hfov, centerShiftRef.current)
      frameRef.current = window.requestAnimationFrame(draw)
    }
    frameRef.current = window.requestAnimationFrame(draw)
    return () => {
      observer?.disconnect()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      stopOrientation()
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
  }, [stopOrientation])

  useEffect(() => {
    const renderer = rendererRef.current
    const request = ++requestRef.current
    setStatus('loading')
    setErrorMessage(null)
    if (!renderer) {
      setStatus('fallback')
      return
    }
    const image = new Image()
    if (needsAnonymousCors(scene.panorama)) image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      if (request !== requestRef.current || !rendererRef.current) return
      try {
        rendererRef.current.uploadPanorama(image)
        setStatus('ready')
        callbacksRef.current.onReady?.()
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error('The panorama could not reach the GPU.')
        setStatus('fallback')
        setErrorMessage(normalized.message)
        callbacksRef.current.onError?.(normalized)
      }
    }
    image.onerror = () => {
      if (request !== requestRef.current) return
      const error = new Error('This panorama image could not be loaded.')
      setStatus('error')
      setErrorMessage(error.message)
      callbacksRef.current.onError?.(error)
    }
    image.src = scene.panorama
    return () => {
      requestRef.current += 1
      image.onload = null
      image.onerror = null
    }
  }, [scene.panorama])

  const pointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (orientationActiveRef.current) return
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])
  const pointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    const dx = event.clientX - pointer.x
    const dy = event.clientY - pointer.y
    pointer.x = event.clientX
    pointer.y = event.clientY
    manualRef.current.yaw -= dx * 0.16
    manualRef.current.pitch = Math.max(-85, Math.min(85, manualRef.current.pitch + dy * 0.14))
  }, [])
  const pointerEnd = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current?.id !== event.pointerId) return
    pointerRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const fallback = status === 'fallback' || status === 'error'
  return (
    <div
      className="ks-stereo-panorama"
      data-panorama={scene.panorama}
      data-scene-title={scene.title}
      data-renderer="single-canvas-stereo"
      data-lens-shape="superellipse"
    >
      <canvas
        ref={canvasRef}
        className="ks-stereo-panorama__canvas"
        role="img"
        aria-label={ariaLabel}
        hidden={fallback}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
      />
      {fallback ? (
        <div className="ks-stereo-panorama__fallback">
          <img
            src={scene.panorama}
            alt={scene.alt}
            onLoad={() => status === 'fallback' && callbacksRef.current.onReady?.()}
          />
          <img src={scene.panorama} alt="" aria-hidden="true" />
        </div>
      ) : null}
      {status === 'loading' ? <span className="ks-stereo-panorama__status" role="status">Preparing panorama…</span> : null}
      {status === 'error' ? <span className="ks-stereo-panorama__status" role="alert">{errorMessage}</span> : null}
    </div>
  )
})
