import { describe, expect, it, vi } from 'vitest'
import { createPannellumAdapter } from './PannellumAdapter'
import type {
  PanoramaScene,
  PannellumConfig,
  PannellumEventName,
  PannellumRuntime,
  PannellumViewerInstance,
} from './types'

const scenes: readonly PanoramaScene[] = [
  {
    id: 'dinner',
    panorama: '/media/dinner.jpg',
    alt: 'A family gathered for dinner.',
    title: 'Sunday dinner',
  },
  {
    id: 'garden',
    panorama: '/media/garden.jpg',
    alt: 'The family garden in spring.',
    title: 'The garden',
  },
]

interface FakeViewer {
  instance: PannellumViewerInstance
  listeners: Map<PannellumEventName, (...args: unknown[]) => void>
}

function createFakeViewer(options: { orientationSupported?: boolean } = {}): FakeViewer {
  const listeners = new Map<
    PannellumEventName,
    (...args: unknown[]) => void
  >()
  let hfov = 100
  let pitch = 0
  let yaw = 0
  let orientationActive = false
  let instance: PannellumViewerInstance

  instance = {
    loadScene: vi.fn(() => instance),
    getScene: vi.fn(() => 'dinner'),
    getPitch: vi.fn(() => pitch),
    getYaw: vi.fn(() => yaw),
    getHfov: vi.fn(() => hfov),
    setPitch: vi.fn((nextPitch) => {
      pitch = nextPitch
      return instance
    }),
    setYaw: vi.fn((nextYaw) => {
      yaw = nextYaw
      return instance
    }),
    setHfov: vi.fn((nextHfov) => {
      hfov = nextHfov
      return instance
    }),
    isOrientationSupported: vi.fn(() => options.orientationSupported ?? true),
    isOrientationActive: vi.fn(() => orientationActive),
    startOrientation: vi.fn(() => {
      orientationActive = true
    }),
    stopOrientation: vi.fn(() => {
      orientationActive = false
    }),
    resize: vi.fn(),
    on: vi.fn((eventName, listener) => {
      listeners.set(eventName, listener)
      return instance
    }),
    off: vi.fn((eventName, listener) => {
      if (listeners.get(eventName) === listener) listeners.delete(eventName)
      return instance
    }),
    destroy: vi.fn(),
  }

  return { instance, listeners }
}

function createFakeRuntime(...viewers: FakeViewer[]) {
  let viewerIndex = 0
  const viewer = vi.fn(
    (_container: HTMLElement | string, _config: PannellumConfig) =>
      viewers[Math.min(viewerIndex++, viewers.length - 1)].instance,
  )
  const runtime: PannellumRuntime = { viewer }
  return { runtime, viewer }
}

describe('createPannellumAdapter', () => {
  it('mounts with touch and wheel input while disabling Pannellum keyboard listeners', async () => {
    const fakeViewer = createFakeViewer()
    const { runtime, viewer } = createFakeRuntime(fakeViewer)
    const adapter = createPannellumAdapter({
      loadRuntime: async () => runtime,
    })

    await adapter.mount(document.createElement('div'), {
      scenes,
      initialSceneId: 'garden',
    })

    const config = viewer.mock.calls[0][1]
    expect(config.default.firstScene).toBe('garden')
    expect(config.draggable).toBe(true)
    expect(config.mouseZoom).toBe(true)
    expect(config.keyboardZoom).toBe(false)
    expect(config.disableKeyboardCtrl).toBe(true)
    expect(config.ignoreGPanoXMP).toBe(true)
    expect(config.escapeHTML).toBe(true)
    expect(config.scenes.dinner.panorama).toBe('/media/dinner.jpg')
    expect(fakeViewer.instance.on).toHaveBeenCalledTimes(3)
  })

  it('removes the exact event listeners and destroys the old viewer before remounting', async () => {
    const firstViewer = createFakeViewer()
    const secondViewer = createFakeViewer()
    const { runtime } = createFakeRuntime(firstViewer, secondViewer)
    const adapter = createPannellumAdapter({
      loadRuntime: async () => runtime,
      requestOrientationPermission: async () => true,
    })

    const container = document.createElement('div')
    await adapter.mount(container, { scenes })
    await adapter.mount(container, { scenes })

    expect(firstViewer.instance.off).toHaveBeenCalledTimes(3)
    expect(firstViewer.listeners.size).toBe(0)
    expect(firstViewer.instance.stopOrientation).toHaveBeenCalledOnce()
    expect(firstViewer.instance.destroy).toHaveBeenCalledOnce()
    expect(secondViewer.instance.on).toHaveBeenCalledTimes(3)
  })

  it('does not create a viewer when an async mount is destroyed before loading', async () => {
    const fakeViewer = createFakeViewer()
    const { runtime, viewer } = createFakeRuntime(fakeViewer)
    let resolveRuntime: ((runtime: PannellumRuntime) => void) | undefined
    const pendingRuntime = new Promise<PannellumRuntime>((resolve) => {
      resolveRuntime = resolve
    })
    const adapter = createPannellumAdapter({
      loadRuntime: () => pendingRuntime,
    })

    const mounting = adapter.mount(document.createElement('div'), { scenes })
    adapter.destroy()
    resolveRuntime?.(runtime)
    await mounting

    expect(viewer).not.toHaveBeenCalled()
  })

  it('changes known scenes and exposes zoom, orientation, and resize controls', async () => {
    const fakeViewer = createFakeViewer({ orientationSupported: true })
    const { runtime } = createFakeRuntime(fakeViewer)
    const adapter = createPannellumAdapter({
      loadRuntime: async () => runtime,
    })
    await adapter.mount(document.createElement('div'), { scenes })

    expect(adapter.changeScene('missing')).toBe(false)
    expect(
      adapter.changeScene('garden', { pitch: 4, yaw: 20, hfov: 85 }),
    ).toBe(true)
    expect(fakeViewer.instance.loadScene).toHaveBeenCalledWith(
      'garden',
      4,
      20,
      85,
    )

    adapter.zoomIn()
    adapter.zoomOut()
    expect(fakeViewer.instance.setHfov).toHaveBeenNthCalledWith(1, 85, 180)
    expect(fakeViewer.instance.setHfov).toHaveBeenNthCalledWith(2, 100, 180)

    adapter.panBy(8, -8)
    expect(fakeViewer.instance.setPitch).toHaveBeenCalledWith(8, 180)
    expect(fakeViewer.instance.setYaw).toHaveBeenCalledWith(-8, 180)

    expect(adapter.getView()).toEqual({ pitch: 8, yaw: -8, hfov: 100 })
    expect(adapter.setView({ pitch: -12, yaw: 42, hfov: 88 })).toBe(true)
    expect(fakeViewer.instance.setPitch).toHaveBeenLastCalledWith(-12, false)
    expect(fakeViewer.instance.setYaw).toHaveBeenLastCalledWith(42, false)
    expect(fakeViewer.instance.setHfov).toHaveBeenLastCalledWith(88, false)
    expect(adapter.getView()).toEqual({ pitch: -12, yaw: 42, hfov: 88 })

    expect(await adapter.startOrientation()).toBe(true)
    expect(adapter.isOrientationActive()).toBe(true)
    adapter.stopOrientation()
    expect(adapter.isOrientationActive()).toBe(false)
    adapter.resize()
    expect(fakeViewer.instance.resize).toHaveBeenCalledOnce()
  })

  it('handles denied permission and a stop during an orientation request', async () => {
    const deniedViewer = createFakeViewer({ orientationSupported: true })
    const deniedRuntime = createFakeRuntime(deniedViewer).runtime
    const deniedAdapter = createPannellumAdapter({
      loadRuntime: async () => deniedRuntime,
      requestOrientationPermission: async () => false,
    })
    await deniedAdapter.mount(document.createElement('div'), { scenes })

    expect(await deniedAdapter.startOrientation()).toBe(false)
    expect(deniedViewer.instance.startOrientation).not.toHaveBeenCalled()

    const pendingViewer = createFakeViewer({ orientationSupported: true })
    const pendingRuntime = createFakeRuntime(pendingViewer).runtime
    let resolvePermission: ((granted: boolean) => void) | undefined
    const permission = new Promise<boolean>((resolve) => {
      resolvePermission = resolve
    })
    const pendingAdapter = createPannellumAdapter({
      loadRuntime: async () => pendingRuntime,
      requestOrientationPermission: () => permission,
    })
    await pendingAdapter.mount(document.createElement('div'), { scenes })

    const starting = pendingAdapter.startOrientation()
    pendingAdapter.stopOrientation()
    resolvePermission?.(true)

    expect(await starting).toBe(false)
    expect(pendingViewer.instance.startOrientation).not.toHaveBeenCalled()
  })

  it('uses a permission already granted for a synchronized Cardboard view', async () => {
    const fakeViewer = createFakeViewer({ orientationSupported: true })
    const runtime = createFakeRuntime(fakeViewer).runtime
    const requestOrientationPermission = vi.fn(async () => false)
    const adapter = createPannellumAdapter({
      loadRuntime: async () => runtime,
      requestOrientationPermission,
    })
    await adapter.mount(document.createElement('div'), { scenes })

    expect(
      await adapter.startOrientation({ permissionAlreadyGranted: true }),
    ).toBe(true)
    expect(requestOrientationPermission).not.toHaveBeenCalled()
    expect(fakeViewer.instance.startOrientation).toHaveBeenCalledOnce()
  })

  it('forwards load, scene, and normalized error events once', async () => {
    const fakeViewer = createFakeViewer()
    const { runtime } = createFakeRuntime(fakeViewer)
    const onLoad = vi.fn()
    const onSceneChange = vi.fn()
    const onError = vi.fn()
    const adapter = createPannellumAdapter({
      loadRuntime: async () => runtime,
    })
    await adapter.mount(document.createElement('div'), {
      scenes,
      onLoad,
      onSceneChange,
      onError,
    })

    fakeViewer.listeners.get('load')?.()
    fakeViewer.listeners.get('scenechange')?.('garden')
    fakeViewer.listeners.get('error')?.('image failed')

    expect(onLoad).toHaveBeenCalledOnce()
    expect(onSceneChange).toHaveBeenCalledWith('garden')
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onError.mock.calls[0][0].message).toBe('image failed')
  })
})
