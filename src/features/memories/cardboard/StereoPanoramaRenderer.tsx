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
  CardboardPoseTracker,
  type CardboardTrackingState,
} from './cardboardPoseTracker'
import {
  deviceOrientationQuaternion,
  evenPixelWidth,
  quaternionToMatrix3,
  resolveStereoViewports,
  type StereoViewportProfile,
  viewQuaternion,
} from './stereoPanoramaMath'
import './StereoPanoramaRenderer.css'

export interface StereoPanoramaRendererHandle {
  /** Attaches motion sensors and resolves after the first usable sample. */
  startOrientation: (options?: PanoramaOrientationStartOptions) => Promise<boolean>
  /** Removes sensor listeners while preserving the displayed pose. */
  stopOrientation: () => void
  /** Reconciles the canvas buffer with its rendered CSS dimensions. */
  resize: () => void
}

export interface StereoPanoramaRendererProps {
  scene: PanoramaScene
  ariaLabel: string
  /** Fraction of each eye width; positive values move both centers inward. */
  opticalCenterShift?: number
  viewportProfile?: StereoViewportProfile
  horizontalFovOverride?: number
  onReady?: () => void
  onError?: (error: Error) => void
  onTrackingStateChange?: (state: CardboardTrackingState) => void
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

/** Compiles one shader and includes the driver log in any actionable failure. */
function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
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

/** Resolves a required uniform instead of letting a broken program render black. */
function requiredUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (!location) throw new Error(`The panorama shader is missing ${name}.`)
  return location
}

/** Owns the single WebGL program, texture, and draw path shared by both eyes. */
class StereoWebGlPanoramaRenderer {
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

  /** Allocates the renderer's complete GPU resource set for one canvas. */
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

  /** Replaces the panorama texture after its browser image has decoded. */
  uploadPanorama(image: HTMLImageElement): void {
    if (this.destroyed) return
    const { gl } = this
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    this.textureReady = true
  }

  /** Sizes the backing buffer without exceeding a 2x device pixel ratio. */
  resize(): void {
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

  /** Draws synchronized left and right lens viewports from one camera pose. */
  render(
    cameraRotation: Float32Array,
    horizontalFovDegrees: number,
    opticalCenterShift: number,
    viewportProfile: StereoViewportProfile,
  ): void {
    if (this.destroyed || !this.textureReady) return
    // ResizeObserver and the native orientation settle timers own measurement;
    // never force layout from the animation loop once the buffer has dimensions.
    if (this.canvas.width < 2 || this.canvas.height < 1) this.resize()
    const { gl, canvas } = this
    // Both lenses receive the same rotation matrix and panorama texture in one
    // animation frame. Only their physical viewport and optical-center signs
    // differ; rendering two independent viewers would let their clocks and
    // sensor samples drift and is a common source of Cardboard eye strain.
    const eyes = resolveStereoViewports(
      canvas.width,
      canvas.height,
      opticalCenterShift,
      viewportProfile,
    )
    const eyeAspect = eyes[0].width / Math.max(eyes[0].height, 1)
    const horizontalFov = Math.max(55, Math.min(110, horizontalFovDegrees))
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniformMatrix3fv(this.locations.cameraRotation, false, cameraRotation)
    gl.uniform1f(this.locations.eyeAspect, eyeAspect)
    gl.uniform1f(
      this.locations.tanHalfHorizontalFov,
      Math.tan((horizontalFov * Math.PI) / 360),
    )
    gl.clear(gl.COLOR_BUFFER_BIT)
    eyes.forEach((eye) => {
      gl.viewport(eye.x, eye.y, eye.width, eye.height)
      gl.uniform1f(this.locations.opticalCenter, eye.opticalCenter)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    })
  }

  /** Releases every GPU resource once; subsequent calls are harmless. */
  destroy(): void {
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

/** Reads standard and legacy screen rotation for sensor-axis correction. */
function screenOrientationAngle(): number {
  const angle = globalThis.screen?.orientation?.angle
  if (typeof angle === 'number') return angle
  const legacy = (window as Window & { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

/** Enables anonymous CORS only for cross-origin HTTP textures. */
function needsAnonymousCors(source: string): boolean {
  try {
    const url = new URL(source, window.location.href)
    return url.protocol.startsWith('http') && url.origin !== window.location.origin
  } catch {
    return false
  }
}

/**
 * Loads a panorama into the shared-eye WebGL renderer and coordinates motion,
 * stale-sensor detection, drag fallback, and accessible image fallback.
 */
export const StereoPanoramaRenderer = forwardRef<
  StereoPanoramaRendererHandle,
  StereoPanoramaRendererProps
>(function StereoPanoramaRenderer(
  {
    scene,
    ariaLabel,
    opticalCenterShift = 0,
    viewportProfile = 'ios-reference',
    horizontalFovOverride,
    onReady,
    onError,
    onTrackingStateChange,
  },
  forwardedRef,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<StereoWebGlPanoramaRenderer | null>(null)
  const callbacksRef = useRef({ onReady, onError, onTrackingStateChange })
  const frameRef = useRef<number | null>(null)
  const requestRef = useRef(0)
  const orientationListenerRef = useRef<((event: DeviceOrientationEvent) => void) | null>(null)
  const screenOrientationListenerRef = useRef<(() => void) | null>(null)
  const visibilityListenerRef = useRef<(() => void) | null>(null)
  const pendingOrientationRef = useRef<PendingOrientationStart | null>(null)
  const [poseTracker] = useState(
    () => new CardboardPoseTracker(
      viewQuaternion(scene.yaw ?? 0, scene.pitch ?? 0),
    ),
  )
  const notifiedTrackingStateRef = useRef<CardboardTrackingState>('waiting')
  const sceneViewRef = useRef({
    yaw: scene.yaw ?? 0,
    pitch: scene.pitch ?? 0,
    horizontalFov: scene.hfov ?? 92,
  })
  const centerShiftRef = useRef(opticalCenterShift)
  const viewportProfileRef = useRef(viewportProfile)
  const horizontalFovOverrideRef = useRef(horizontalFovOverride)
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const [status, setStatus] = useState<RendererStatus>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    callbacksRef.current = { onReady, onError, onTrackingStateChange }
  }, [onError, onReady, onTrackingStateChange])
  useEffect(() => { centerShiftRef.current = opticalCenterShift }, [opticalCenterShift])
  useEffect(() => { viewportProfileRef.current = viewportProfile }, [viewportProfile])
  useEffect(() => {
    horizontalFovOverrideRef.current = horizontalFovOverride
  }, [horizontalFovOverride])
  useEffect(() => {
    sceneViewRef.current = {
      yaw: scene.yaw ?? 0,
      pitch: scene.pitch ?? 0,
      horizontalFov: scene.hfov ?? 92,
    }
    poseTracker.reset(viewQuaternion(scene.yaw ?? 0, scene.pitch ?? 0))
    notifiedTrackingStateRef.current = 'waiting'
  }, [poseTracker, scene.id, scene.hfov, scene.pitch, scene.yaw])

  /** Emits tracker transitions once so parent status updates do not churn. */
  const notifyTrackingState = useCallback((state: CardboardTrackingState) => {
    if (notifiedTrackingStateRef.current === state) return
    notifiedTrackingStateRef.current = state
    callbacksRef.current.onTrackingStateChange?.(state)
  }, [])

  /** Settles pending startup and removes every sensor lifecycle listener. */
  const stopOrientation = useCallback(() => {
    // startOrientation may still be waiting for its first usable sample. Settle
    // that promise before removing every listener so an exit/unmount cannot
    // leave the parent in a permanent "starting" state or leak sensor access.
    pendingOrientationRef.current?.settle(false)
    pendingOrientationRef.current = null
    const listener = orientationListenerRef.current
    if (listener) window.removeEventListener('deviceorientation', listener)
    const screenListener = screenOrientationListenerRef.current
    if (screenListener) {
      globalThis.screen?.orientation?.removeEventListener?.('change', screenListener)
      window.removeEventListener('orientationchange', screenListener)
    }
    const visibilityListener = visibilityListenerRef.current
    if (visibilityListener) {
      document.removeEventListener('visibilitychange', visibilityListener)
    }
    orientationListenerRef.current = null
    screenOrientationListenerRef.current = null
    visibilityListenerRef.current = null
    poseTracker.stopTracking()
    notifiedTrackingStateRef.current = 'waiting'
  }, [poseTracker])

  /** Attaches one validated sensor stream and resolves after its first sample. */
  const startOrientation = useCallback(async (_options?: PanoramaOrientationStartOptions) => {
    if (!rendererRef.current || typeof globalThis.DeviceOrientationEvent === 'undefined') return false
    // CardboardViewer already consumed any iOS permission prompt in the original
    // Go gesture. This renderer deliberately ignores the permission flag and
    // owns only listener attachment, first-sample validation and cleanup.
    stopOrientation()
    poseTracker.prepareForTracking()
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timeout = 0
      /** Validates and converts a browser orientation sample into viewer space. */
      const listener = (event: DeviceOrientationEvent) => {
        if (
          event.alpha === null ||
          event.beta === null ||
          event.gamma === null ||
          !Number.isFinite(event.alpha) ||
          !Number.isFinite(event.beta) ||
          !Number.isFinite(event.gamma)
        ) return
        const receiptTime = performance.now()
        const screenAngle = screenOrientationAngle()
        const sample = deviceOrientationQuaternion(
          event.alpha,
          event.beta,
          event.gamma,
          screenAngle,
        )
        const state = poseTracker.sample(
          sample,
          screenAngle,
          Number.isFinite(event.timeStamp) ? event.timeStamp : receiptTime,
          receiptTime,
        )
        if (state) notifyTrackingState(state)
        settle(true)
      }
      /** Rebases sensor coordinates after the physical screen rotates. */
      const handleScreenOrientationChange = () => {
        // DeviceOrientation axes change with the screen. Rebase on the next
        // sample instead of composing across coordinate systems and producing a
        // sudden quarter-turn while the native controller settles landscape.
        poseTracker.markScreenOrientationChanged()
      }
      /** Marks hidden-page sensors stale and rebases them on return. */
      const handleVisibilityChange = () => {
        if (document.visibilityState !== 'hidden') {
          poseTracker.markScreenOrientationChanged()
          return
        }
        if (poseTracker.markStale()) notifyTrackingState('stale')
      }
      /** Resolves startup exactly once and performs failure-only cleanup. */
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
          globalThis.screen?.orientation?.removeEventListener?.(
            'change',
            handleScreenOrientationChange,
          )
          window.removeEventListener(
            'orientationchange',
            handleScreenOrientationChange,
          )
          document.removeEventListener(
            'visibilitychange',
            handleVisibilityChange,
          )
          screenOrientationListenerRef.current = null
          visibilityListenerRef.current = null
          poseTracker.stopTracking()
          notifiedTrackingStateRef.current = 'waiting'
        }
        resolve(started)
      }

      orientationListenerRef.current = listener
      screenOrientationListenerRef.current = handleScreenOrientationChange
      visibilityListenerRef.current = handleVisibilityChange
      pendingOrientationRef.current = { settle }
      window.addEventListener('deviceorientation', listener)
      globalThis.screen?.orientation?.addEventListener?.(
        'change',
        handleScreenOrientationChange,
      )
      window.addEventListener('orientationchange', handleScreenOrientationChange)
      document.addEventListener('visibilitychange', handleVisibilityChange)
      timeout = window.setTimeout(() => settle(false), 1500)
    })
  }, [notifyTrackingState, poseTracker, stopOrientation])

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
      // oxlint-disable-next-line react/set-state-in-effect -- WebGL allocation is an external browser resource check.
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

    /** Renders one pose to both eyes and schedules the next synchronized frame. */
    const draw = () => {
      const renderer = rendererRef.current
      if (!renderer) return
      const view = sceneViewRef.current
      if (poseTracker.updateStaleness(performance.now())) {
        notifyTrackingState('stale')
      }
      const pose = poseTracker.getPose()
      renderer.render(
        quaternionToMatrix3(pose),
        horizontalFovOverrideRef.current ?? view.horizontalFov,
        centerShiftRef.current,
        viewportProfileRef.current,
      )
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
  }, [notifyTrackingState, poseTracker, stopOrientation])

  useEffect(() => {
    const renderer = rendererRef.current
    const request = ++requestRef.current
    // oxlint-disable-next-line react/set-state-in-effect -- Loading follows the external image resource lifecycle.
    setStatus('loading')
    setErrorMessage(null)
    if (!renderer) {
      setStatus('fallback')
      return
    }
    // Image URLs, including blob: URLs created by the journal, are borrowed.
    // The renderer cancels callbacks by generation but never revokes the URL,
    // because the flat-image and native-viewer fallbacks may still share it.
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

  /** Starts manual synchronized drag only when head tracking is unavailable. */
  const pointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    // Touch / pointer drag is a synchronized fallback only while sensors are
    // absent or stale. Active head tracking remains the sole pose owner so a
    // finger cannot fight the headset and create a different view per frame.
    if (poseTracker.getState() === 'active') return
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [poseTracker])
  /** Converts pointer movement into bounded yaw/pitch fallback deltas. */
  const pointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const pointer = pointerRef.current
    if (!pointer || pointer.id !== event.pointerId) return
    const horizontalDelta = event.clientX - pointer.x
    const verticalDelta = event.clientY - pointer.y
    pointer.x = event.clientX
    pointer.y = event.clientY
    poseTracker.applyManualDelta(
      -horizontalDelta * 0.16,
      verticalDelta * 0.14,
    )
  }, [poseTracker])
  /** Ends the matching manual-drag pointer and releases capture defensively. */
  const pointerEnd = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current?.id !== event.pointerId) return
    pointerRef.current = null
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // Pointer cancellation may release capture before React dispatches it.
    }
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
