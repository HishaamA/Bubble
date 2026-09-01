import type { PannellumRuntime, PannellumRuntimeLoader } from './types'

const SCRIPT_PATH = '/vendor/pannellum/pannellum.js'
const STYLESHEET_PATH = '/vendor/pannellum/pannellum.css'
const ASSET_MARKER = 'data-kinsphere-pannellum'

type WindowWithPannellum = Window & {
  pannellum?: PannellumRuntime
}

let runtimePromise: Promise<PannellumRuntime> | undefined

function currentRuntime(): PannellumRuntime | undefined {
  return (window as WindowWithPannellum).pannellum
}

function ensureStylesheet(): void {
  // The stylesheet belongs to the document, not an individual viewer. Keeping
  // one marked node avoids duplicate downloads and prevents an unmount from
  // removing styles while another panorama is still alive.
  const existing = document.querySelector<HTMLLinkElement>(
    `link[${ASSET_MARKER}="style"], link[href="${STYLESHEET_PATH}"]`,
  )

  if (existing) return

  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = STYLESHEET_PATH
  link.setAttribute(ASSET_MARKER, 'style')
  document.head.append(link)
}

function loadRuntime(): Promise<PannellumRuntime> {
  const loadedRuntime = currentRuntime()
  if (loadedRuntime) return Promise.resolve(loadedRuntime)

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[${ASSET_MARKER}="script"], script[src="${SCRIPT_PATH}"]`,
    )
    const script = existing ?? document.createElement('script')

    const cleanup = () => {
      script.removeEventListener('load', handleLoad)
      script.removeEventListener('error', handleError)
    }
    const handleLoad = () => {
      cleanup()
      const runtime = currentRuntime()
      if (runtime) {
        resolve(runtime)
      } else {
        if (script.getAttribute(ASSET_MARKER) === 'script') script.remove()
        reject(new Error('Pannellum loaded without exposing its viewer API.'))
      }
    }
    const handleError = () => {
      cleanup()
      if (script.getAttribute(ASSET_MARKER) === 'script') script.remove()
      reject(new Error(`Could not load the bundled viewer at ${SCRIPT_PATH}.`))
    }

    script.addEventListener('load', handleLoad, { once: true })
    script.addEventListener('error', handleError, { once: true })

    if (!existing) {
      script.src = SCRIPT_PATH
      script.async = true
      script.setAttribute(ASSET_MARKER, 'script')
      document.head.append(script)
    }
  })
}

/** Loads the repository-bundled Pannellum assets once; no CDN is used. */
export const loadPannellum: PannellumRuntimeLoader = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(
      new Error('The panorama viewer is only available in a browser.'),
    )
  }

  ensureStylesheet()
  // Concurrent viewer mounts share one import. A failed load clears the cache
  // so a later route can retry after a transient asset / WebView error, while a
  // successful runtime remains document-global for the app lifetime.
  runtimePromise ??= loadRuntime().catch((error: unknown) => {
    runtimePromise = undefined
    throw error
  })
  return runtimePromise
}
