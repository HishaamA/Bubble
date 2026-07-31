export type PanoramaHotSpotKind = 'info' | 'scene' | 'audio'

export interface PanoramaHotSpot {
  id: string
  kind: PanoramaHotSpotKind
  pitch: number
  yaw: number
  label: string
  sceneId?: string
  targetPitch?: number
  targetYaw?: number
  targetHfov?: number
  onActivate?: (event: Event) => void
}

export interface PanoramaScene {
  id: string
  panorama: string
  /** Meaningful text used by the non-WebGL fallback image. */
  alt: string
  title?: string
  description?: string
  preview?: string
  pitch?: number
  yaw?: number
  hfov?: number
  minHfov?: number
  maxHfov?: number
  hotSpots?: readonly PanoramaHotSpot[]
}

export interface PanoramaView {
  pitch?: number
  yaw?: number
  hfov?: number
}

export interface PanoramaMountOptions {
  scenes: readonly PanoramaScene[]
  initialSceneId?: string
  initialView?: PanoramaView
  onLoad?: () => void
  onSceneChange?: (sceneId: string) => void
  onError?: (error: Error) => void
}

export interface PanoramaAdapter {
  mount: (
    container: HTMLElement,
    options: PanoramaMountOptions,
  ) => Promise<void>
  changeScene: (sceneId: string, view?: PanoramaView) => boolean
  startOrientation: () => Promise<boolean>
  stopOrientation: () => void
  isOrientationSupported: () => boolean
  isOrientationActive: () => boolean
  panBy: (pitchDelta: number, yawDelta: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resize: () => void
  destroy: () => void
}

export interface PannellumHotSpotConfig {
  id: string
  pitch: number
  yaw: number
  type: 'info' | 'scene'
  text?: string
  sceneId?: string
  targetPitch?: number
  targetYaw?: number
  targetHfov?: number
  cssClass?: string
  clickHandlerFunc?: (event: Event) => void
  createTooltipFunc?: (element: HTMLElement) => void
}

export interface PannellumSceneConfig {
  type: 'equirectangular'
  panorama: string
  title?: string
  preview?: string
  pitch?: number
  yaw?: number
  hfov?: number
  minHfov?: number
  maxHfov?: number
  hotSpots?: PannellumHotSpotConfig[]
}

export interface PannellumConfig {
  default: {
    firstScene: string
    sceneFadeDuration: number
  }
  scenes: Record<string, PannellumSceneConfig>
  autoLoad: boolean
  draggable: boolean
  mouseZoom: boolean
  keyboardZoom: boolean
  doubleClickZoom: boolean
  showControls: boolean
  showZoomCtrl: boolean
  showFullscreenCtrl: boolean
  orientationOnByDefault: boolean
  disableKeyboardCtrl: boolean
  ignoreGPanoXMP: boolean
  escapeHTML: boolean
  backgroundColor: [number, number, number]
}

export type PannellumEventName = 'load' | 'scenechange' | 'error'

export interface PannellumViewerInstance {
  loadScene: (
    sceneId: string,
    pitch?: number,
    yaw?: number,
    hfov?: number,
  ) => PannellumViewerInstance
  getScene: () => string
  getPitch: () => number
  getYaw: () => number
  getHfov: () => number
  setPitch: (
    pitch: number,
    animated?: number | boolean,
  ) => PannellumViewerInstance
  setYaw: (yaw: number, animated?: number | boolean) => PannellumViewerInstance
  setHfov: (hfov: number, animated?: number | boolean) => PannellumViewerInstance
  isOrientationSupported: () => boolean
  isOrientationActive: () => boolean
  startOrientation: () => void
  stopOrientation: () => void
  resize: () => void
  on: (
    eventName: PannellumEventName,
    listener: (...args: unknown[]) => void,
  ) => PannellumViewerInstance
  off: (
    eventName: PannellumEventName,
    listener: (...args: unknown[]) => void,
  ) => PannellumViewerInstance
  destroy: () => void
}

export interface PannellumRuntime {
  viewer: (
    container: HTMLElement | string,
    config: PannellumConfig,
  ) => PannellumViewerInstance
}

export type PannellumRuntimeLoader = () => Promise<PannellumRuntime>
