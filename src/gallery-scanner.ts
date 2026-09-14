import { installGalleryScannerEngine } from './gallery-scanner/galleryScannerEngine'

const host = window.BubbleGalleryHost
if (
  !host ||
  typeof host.ready !== 'function' ||
  typeof host.complete !== 'function' ||
  typeof host.failed !== 'function'
) {
  throw new Error('BubbleGalleryHost is unavailable')
}

installGalleryScannerEngine(window, host)
