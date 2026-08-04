import { loadPannellum } from './loadPannellum'
import type {
  PanoramaAdapter,
  PanoramaHotSpot,
  PanoramaMountOptions,
  PanoramaOrientationStartOptions,
  PanoramaScene,
  PanoramaView,
  PanoramaViewState,
  PannellumConfig,
  PannellumEventName,
  PannellumHotSpotConfig,
  PannellumRuntimeLoader,
  PannellumViewerInstance,
} from './types'

const ZOOM_STEP = 15

export interface PannellumAdapterDependencies {
  /** Primarily useful for unit tests; production uses the bundled asset loader. */
  loadRuntime?: PannellumRuntimeLoader
  /** Primarily useful for testing the iOS permission lifecycle. */
  requestOrientationPermission?: () => Promise<boolean>
}

type PermissionCapableEvent = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'denied' | 'granted'>
}

async function requestBrowserOrientationPermission(): Promise<boolean> {
  const orientationEvent = globalThis.DeviceOrientationEvent as
    | PermissionCapableEvent
    | undefined
  const requestPermission = orientationEvent?.requestPermission

  if (!requestPermission) return true

  try {
    return (await requestPermission.call(orientationEvent)) === 'granted'
  } catch {
    return false
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  return new Error('The panorama could not be displayed.')
}

function addKeyboardActivation(element: HTMLElement): void {
  if (element.dataset.keyboardActivation === 'true') return
  element.dataset.keyboardActivation = 'true'
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    element.click()
  })
}

function createAccessibleHotSpot(
  element: HTMLElement,
  hotSpot: PanoramaHotSpot,
): void {
  element.classList.add(
    'ks-panorama-hotspot',
    `ks-panorama-hotspot--${hotSpot.kind}`,
  )
  element.tabIndex = 0
  element.setAttribute('role', hotSpot.kind === 'scene' ? 'link' : 'button')
  element.setAttribute('aria-label', hotSpot.label)

  const tooltip = document.createElement('span')
  tooltip.className = 'ks-panorama-hotspot__label'
  tooltip.textContent = hotSpot.label
  element.append(tooltip)
  addKeyboardActivation(element)
}

function mapHotSpot(hotSpot: PanoramaHotSpot): PannellumHotSpotConfig {
  const config: PannellumHotSpotConfig = {
    id: hotSpot.id,
    pitch: hotSpot.pitch,
    yaw: hotSpot.yaw,
    type: hotSpot.kind === 'scene' ? 'scene' : 'info',
    text: hotSpot.label,
    sceneId: hotSpot.sceneId,
    targetPitch: hotSpot.targetPitch,
    targetYaw: hotSpot.targetYaw,
    targetHfov: hotSpot.targetHfov,
    cssClass: `ks-panorama-hotspot ks-panorama-hotspot--${hotSpot.kind}`,
    createTooltipFunc: (element) => createAccessibleHotSpot(element, hotSpot),
  }

  if (hotSpot.onActivate) {
    config.clickHandlerFunc = (event) => hotSpot.onActivate?.(event)
  }

  return config
}

function mapScene(scene: PanoramaScene) {
  return {
    type: 'equirectangular' as const,
    panorama: scene.panorama,
    title: scene.title,
    preview: scene.preview,
    pitch: scene.pitch,
    yaw: scene.yaw,
    hfov: scene.hfov,
    minHfov: scene.minHfov,
    maxHfov: scene.maxHfov,
    hotSpots: scene.hotSpots?.map(mapHotSpot),
  }
}

function buildConfig(options: PanoramaMountOptions): PannellumConfig {
  if (options.scenes.length === 0) {
    throw new Error('At least one panorama scene is required.')
  }

  const sceneIds = new Set(options.scenes.map(({ id }) => id))
  if (sceneIds.size !== options.scenes.length) {
    throw new Error('Panorama scene IDs must be unique.')
  }

  const firstScene = options.initialSceneId ?? options.scenes[0].id
  if (!sceneIds.has(firstScene)) {
    throw new Error(`Unknown initial panorama scene: ${firstScene}`)
  }

  const scenes = Object.fromEntries(
    options.scenes.map((scene) => {
      const mappedScene = mapScene(scene)
      if (scene.id === firstScene) {
        mappedScene.pitch = options.initialView?.pitch ?? mappedScene.pitch
        mappedScene.yaw = options.initialView?.yaw ?? mappedScene.yaw
        mappedScene.hfov = options.initialView?.hfov ?? mappedScene.hfov
      }
      return [scene.id, mappedScene]
    }),
  )

  return {
    default: {
      firstScene,
      sceneFadeDuration: 500,
    },
    scenes,
    autoLoad: true,
    draggable: true,
    mouseZoom: true,
    keyboardZoom: false,
    doubleClickZoom: true,
    showControls: false,
    showZoomCtrl: false,
    showFullscreenCtrl: false,
    orientationOnByDefault: false,
    disableKeyboardCtrl: true,
    ignoreGPanoXMP: true,
    escapeHTML: true,
    backgroundColor: [0, 0, 0],
  }
}

export function createPannellumAdapter(
  dependencies: PannellumAdapterDependencies = {},
): PanoramaAdapter {
  const runtimeLoader = dependencies.loadRuntime ?? loadPannellum
  const requestOrientationPermission =
    dependencies.requestOrientationPermission ??
    requestBrowserOrientationPermission
  let viewer: PannellumViewerInstance | undefined
  let mountVersion = 0
  let orientationRequestVersion = 0
  let availableSceneIds = new Set<string>()
  let listeners: Array<{
    eventName: PannellumEventName
    listener: (...args: unknown[]) => void
  }> = []

  const removeListeners = () => {
    if (!viewer) return
    listeners.forEach(({ eventName, listener }) => {
      viewer?.off(eventName, listener)
    })
    listeners = []
  }

  const destroyViewer = () => {
    if (!viewer) return
    removeListeners()
    viewer.stopOrientation()
    viewer.destroy()
    viewer = undefined
  }

  const destroy = () => {
    mountVersion += 1
    orientationRequestVersion += 1
    destroyViewer()
    availableSceneIds = new Set()
  }

  const mount = async (
    container: HTMLElement,
    options: PanoramaMountOptions,
  ): Promise<void> => {
    destroy()
    const requestedMount = mountVersion
    const config = buildConfig(options)
    const runtime = await runtimeLoader()

    if (requestedMount !== mountVersion) return

    availableSceneIds = new Set(options.scenes.map(({ id }) => id))
    viewer = runtime.viewer(container, config)

    const bind = (
      eventName: PannellumEventName,
      listener: (...args: unknown[]) => void,
    ) => {
      viewer?.on(eventName, listener)
      listeners.push({ eventName, listener })
    }

    bind('load', () => options.onLoad?.())
    bind('scenechange', (sceneId) => {
      if (typeof sceneId === 'string') options.onSceneChange?.(sceneId)
    })
    bind('error', (error) => options.onError?.(toError(error)))
  }

  const changeScene = (sceneId: string, view: PanoramaView = {}): boolean => {
    if (!viewer || !availableSceneIds.has(sceneId)) return false
    viewer.loadScene(sceneId, view.pitch, view.yaw, view.hfov)
    return true
  }

  const startOrientation = async (
    options: PanoramaOrientationStartOptions = {},
  ): Promise<boolean> => {
    const orientationViewer = viewer
    if (!orientationViewer?.isOrientationSupported()) return false
    const requestedOrientation = ++orientationRequestVersion

    let permissionGranted = false
    try {
      permissionGranted =
        options.permissionAlreadyGranted ||
        (await requestOrientationPermission())
    } catch {
      permissionGranted = false
    }
    if (
      !permissionGranted ||
      viewer !== orientationViewer ||
      requestedOrientation !== orientationRequestVersion
    ) {
      return false
    }

    try {
      // KinSphere owns the standards-based permission request above. The
      // bundled runtime only attaches its deviceorientation listener, avoiding
      // a second, non-gesture iOS permission request.
      orientationViewer.startOrientation()
      await Promise.resolve()
    } catch {
      return false
    }
    return (
      viewer === orientationViewer &&
      requestedOrientation === orientationRequestVersion &&
      orientationViewer.isOrientationActive()
    )
  }

  const stopOrientation = () => {
    orientationRequestVersion += 1
    viewer?.stopOrientation()
  }

  const getView = (): PanoramaViewState | null => {
    if (!viewer) return null
    const view = {
      pitch: viewer.getPitch(),
      yaw: viewer.getYaw(),
      hfov: viewer.getHfov(),
    }
    return Object.values(view).every(Number.isFinite) ? view : null
  }

  const setView = (view: PanoramaViewState): boolean => {
    if (!viewer || !Object.values(view).every(Number.isFinite)) return false

    if (Math.abs(viewer.getPitch() - view.pitch) > 0.001) {
      viewer.setPitch(view.pitch, false)
    }
    if (Math.abs(viewer.getYaw() - view.yaw) > 0.001) {
      viewer.setYaw(view.yaw, false)
    }
    if (Math.abs(viewer.getHfov() - view.hfov) > 0.001) {
      viewer.setHfov(view.hfov, false)
    }
    return true
  }

  const zoom = (delta: number) => {
    if (!viewer) return
    viewer.setHfov(viewer.getHfov() + delta, 180)
  }

  const panBy = (pitchDelta: number, yawDelta: number) => {
    if (!viewer) return
    stopOrientation()
    viewer.setPitch(viewer.getPitch() + pitchDelta, 180)
    viewer.setYaw(viewer.getYaw() + yawDelta, 180)
  }

  return {
    mount,
    changeScene,
    startOrientation,
    stopOrientation,
    isOrientationSupported: () => viewer?.isOrientationSupported() ?? false,
    isOrientationActive: () => viewer?.isOrientationActive() ?? false,
    getView,
    setView,
    panBy,
    zoomIn: () => zoom(-ZOOM_STEP),
    zoomOut: () => zoom(ZOOM_STEP),
    resize: () => viewer?.resize(),
    destroy,
  }
}
