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

/** Allows omitted view fields but rejects non-finite values at the vendor edge. */
function isFiniteWhenDefined(value: number | undefined): boolean {
  return value === undefined || Number.isFinite(value)
}

/** Validates the subset of camera state callers may override. */
function isValidPartialView(view: PanoramaView): boolean {
  return (
    isFiniteWhenDefined(view.pitch) &&
    isFiniteWhenDefined(view.yaw) &&
    isFiniteWhenDefined(view.hfov) &&
    (view.hfov === undefined || view.hfov > 0)
  )
}

/** Rejects malformed runtime data before Pannellum mutates the document. */
function validateScenes(scenes: readonly PanoramaScene[]): Set<string> {
  if (scenes.length === 0) {
    throw new Error('At least one panorama scene is required.')
  }

  if (scenes.some(({ id }) => typeof id !== 'string' || !id.trim())) {
    throw new Error('Panorama scene IDs must be non-empty and unique.')
  }
  const sceneIds = new Set(scenes.map(({ id }) => id))
  if (sceneIds.size !== scenes.length) {
    throw new Error('Panorama scene IDs must be non-empty and unique.')
  }

  for (const scene of scenes) {
    if (
      typeof scene.panorama !== 'string' ||
      !scene.panorama.trim() ||
      typeof scene.alt !== 'string' ||
      !scene.alt.trim()
    ) {
      throw new Error(`Panorama scene ${scene.id} needs an image and alt text.`)
    }
    if (
      !isValidPartialView(scene) ||
      !isFiniteWhenDefined(scene.minHfov) ||
      !isFiniteWhenDefined(scene.maxHfov) ||
      (scene.minHfov !== undefined && scene.minHfov <= 0) ||
      (scene.maxHfov !== undefined && scene.maxHfov <= 0) ||
      (scene.minHfov !== undefined &&
        scene.maxHfov !== undefined &&
        scene.minHfov > scene.maxHfov)
    ) {
      throw new Error(`Panorama scene ${scene.id} has an invalid view.`)
    }

    const hotSpotIds = new Set<string>()
    for (const hotSpot of scene.hotSpots ?? []) {
      if (
        typeof hotSpot.id !== 'string' ||
        !hotSpot.id.trim() ||
        hotSpotIds.has(hotSpot.id)
      ) {
        throw new Error(
          `Panorama scene ${scene.id} has a missing or duplicate hotspot ID.`,
        )
      }
      hotSpotIds.add(hotSpot.id)
      if (
        typeof hotSpot.label !== 'string' ||
        !hotSpot.label.trim() ||
        !Number.isFinite(hotSpot.pitch) ||
        !Number.isFinite(hotSpot.yaw) ||
        !isFiniteWhenDefined(hotSpot.targetPitch) ||
        !isFiniteWhenDefined(hotSpot.targetYaw) ||
        !isFiniteWhenDefined(hotSpot.targetHfov) ||
        (hotSpot.targetHfov !== undefined && hotSpot.targetHfov <= 0)
      ) {
        throw new Error(
          `Panorama hotspot ${hotSpot.id} has invalid display data.`,
        )
      }
      if (
        hotSpot.kind === 'scene' &&
        (!hotSpot.sceneId || !sceneIds.has(hotSpot.sceneId))
      ) {
        throw new Error(
          `Panorama hotspot ${hotSpot.id} links to an unknown scene.`,
        )
      }
    }
  }

  return sceneIds
}

/** Requests iOS motion permission only when the browser exposes that gate. */
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

/** Normalizes thrown runtime values to the adapter's public Error contract. */
function toError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  return new Error('The panorama could not be displayed.')
}

/** Gives Pannellum's generated div hotspots native button key behavior. */
function addKeyboardActivation(element: HTMLElement): void {
  if (element.dataset.keyboardActivation === 'true') return
  element.dataset.keyboardActivation = 'true'
  element.addEventListener('keydown', (event) => {
    // Pannellum creates hotspots as clickable divs. Mirroring native button
    // activation here makes its existing click / scene-change path reachable
    // without inventing a second action path that could diverge from pointer use.
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    element.click()
  })
}

/** Adds semantics and a visible label to Pannellum's generated hotspot node. */
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

/** Converts one app hotspot without exposing vendor-specific fields upstream. */
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

/** Converts one validated scene while leaving its panorama URL caller-owned. */
function mapScene(scene: PanoramaScene) {
  return {
    type: 'equirectangular' as const,
    // The adapter borrows this URL. In particular, it must not revoke blob:
    // sources during destroy because a flat fallback, Cardboard bridge or a
    // freshly mounted adapter may still be displaying the same journal asset.
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

/** Maps validated app scenes to the deliberately narrow vendor configuration. */
function buildConfig(options: PanoramaMountOptions): PannellumConfig {
  const sceneIds = validateScenes(options.scenes)
  if (options.initialView && !isValidPartialView(options.initialView)) {
    throw new Error('The initial panorama view is invalid.')
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
    // React exposes one scoped keyboard surface with documented shortcuts.
    // Disable Pannellum's document-level handler to prevent one keystroke from
    // panning twice or stealing arrows from the accessible flat-mode picker.
    disableKeyboardCtrl: true,
    ignoreGPanoXMP: true,
    escapeHTML: true,
    backgroundColor: [0, 0, 0],
  }
}

/**
 * Wraps Pannellum's imperative viewer in a lifecycle-safe, testable adapter.
 * One adapter owns at most one viewer and invalidates non-abortable async work
 * whenever that viewer is replaced or destroyed.
 */
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
  let eventListeners: Array<{
    eventName: PannellumEventName
    listener: (...args: unknown[]) => void
  }> = []

  /** Detaches every listener registered by the current adapter mount. */
  const removeListeners = (ownedViewer: PannellumViewerInstance) => {
    for (const { eventName, listener } of eventListeners) {
      try {
        ownedViewer.off(eventName, listener)
      } catch {
        // Continue detaching the remaining global listeners even if a damaged
        // runtime fails to remove one of them.
      }
    }
    eventListeners = []
  }

  /** Tears down the currently owned runtime instance without throwing on exit. */
  const destroyViewer = () => {
    if (!viewer) return
    const ownedViewer = viewer
    // Clear ownership first so callbacks fired during Pannellum teardown can
    // never act on a viewer that is already leaving the document.
    viewer = undefined
    removeListeners(ownedViewer)
    try {
      ownedViewer.stopOrientation()
    } catch {
      // Destruction below must still run if a browser sensor API is damaged.
    }
    try {
      ownedViewer.destroy()
    } catch {
      // Pannellum cleanup is best-effort during route teardown. Version guards
      // already prevent any late callback from reclaiming adapter ownership.
    }
  }

  /** Invalidates pending imports and permission requests before teardown. */
  const destroy = () => {
    // Version counters invalidate both kinds of async work: a runtime import
    // resolving after unmount and an iOS permission promise resolving after
    // stop / scene replacement. The underlying APIs are not abortable.
    mountVersion += 1
    orientationRequestVersion += 1
    destroyViewer()
    availableSceneIds = new Set()
  }

  /** Replaces the owned viewer after the bundled runtime is available. */
  const mount = async (
    container: HTMLElement,
    options: PanoramaMountOptions,
  ): Promise<void> => {
    // Pannellum owns imperative DOM and global listeners, so remounting must
    // fully destroy the prior instance before another one touches the container.
    destroy()
    const requestedMount = mountVersion
    const config = buildConfig(options)
    const runtime = await runtimeLoader()

    if (requestedMount !== mountVersion) return

    availableSceneIds = new Set(options.scenes.map(({ id }) => id))
    viewer = runtime.viewer(container, config)

    /** Records each vendor listener so remount and destroy can detach it. */
    const bind = (
      eventName: PannellumEventName,
      listener: (...args: unknown[]) => void,
    ) => {
      viewer?.on(eventName, listener)
      eventListeners.push({ eventName, listener })
    }

    bind('load', () => options.onLoad?.())
    bind('scenechange', (sceneId) => {
      if (typeof sceneId === 'string') options.onSceneChange?.(sceneId)
    })
    bind('error', (error) => options.onError?.(toError(error)))
  }

  /** Loads a known scene only when its optional camera override is valid. */
  const changeScene = (sceneId: string, view: PanoramaView = {}): boolean => {
    if (
      !viewer ||
      !availableSceneIds.has(sceneId) ||
      !isValidPartialView(view)
    ) {
      return false
    }
    viewer.loadScene(sceneId, view.pitch, view.yaw, view.hfov)
    return true
  }

  /** Starts sensor control only for the viewer that requested permission. */
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
      // Permission may resolve after the component stopped orientation or
      // mounted a replacement viewer. Never attach sensors to that stale owner.
      return false
    }

    try {
      // Bubble owns the standards-based permission request above. The
      // bundled runtime only attaches its deviceorientation listener, avoiding
      // a second, non-gesture iOS permission request.
      orientationViewer.startOrientation()
      await Promise.resolve()
    } catch {
      // A runtime can attach its listener before a platform sensor exception is
      // thrown. Always ask that same captured instance to unwind, even if a new
      // viewer has since replaced it.
      try {
        orientationViewer.stopOrientation()
      } catch {
        // The React wrapper will remain in drag mode; cleanup is best effort.
      }
      return false
    }
    return (
      viewer === orientationViewer &&
      requestedOrientation === orientationRequestVersion &&
      orientationViewer.isOrientationActive()
    )
  }

  /** Cancels pending permission ownership and detaches the active sensor. */
  const stopOrientation = () => {
    orientationRequestVersion += 1
    try {
      viewer?.stopOrientation()
    } catch {
      // Manual drag remains available even if the platform sensor listener has
      // already disappeared underneath Pannellum.
    }
  }

  /** Returns a complete camera snapshot or null for corrupt runtime values. */
  const getView = (): PanoramaViewState | null => {
    if (!viewer) return null
    const view = {
      pitch: viewer.getPitch(),
      yaw: viewer.getYaw(),
      hfov: viewer.getHfov(),
    }
    return Object.values(view).every(Number.isFinite) ? view : null
  }

  /** Converts a pointer event to spherical coordinates without leaking errors. */
  const getCoordinatesFromEvent = (
    event: MouseEvent,
  ): Pick<PanoramaViewState, 'pitch' | 'yaw'> | null => {
    if (!viewer) return null

    try {
      const [pitch, yaw] = viewer.mouseEventToCoords(event)
      return Number.isFinite(pitch) && Number.isFinite(yaw)
        ? { pitch, yaw }
        : null
    } catch {
      return null
    }
  }

  /** Synchronizes a complete finite camera view without transition animation. */
  const setView = (view: PanoramaViewState): boolean => {
    if (!viewer || !isValidPartialView(view)) return false

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

  /** Adjusts horizontal field of view using Pannellum's animated setter. */
  const zoom = (delta: number) => {
    if (!viewer) return
    viewer.setHfov(viewer.getHfov() + delta, 180)
  }

  /** Hands camera ownership from device motion to explicit keyboard panning. */
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
    getCoordinatesFromEvent,
    setView,
    panBy,
    zoomIn: () => zoom(-ZOOM_STEP),
    zoomOut: () => zoom(ZOOM_STEP),
    resize: () => viewer?.resize(),
    destroy,
  }
}
