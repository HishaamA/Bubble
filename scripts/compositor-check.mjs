// Vite development harness only: this file is not part of the app build.
import { composeGuidedPanorama } from '../src/services/media/composeGuidedPanorama.ts'

const filesInput = document.querySelector('#files')
const run = document.querySelector('#run')
const cancel = document.querySelector('#cancel')
const status = document.querySelector('#status')
const output = document.querySelector('#output')
const download = document.querySelector('#download')
let controller
let outputUrl
filesInput.addEventListener('change', () => { run.disabled = !filesInput.files.length })
cancel.addEventListener('click', () => controller?.abort())
run.addEventListener('click', async () => {
  const references = []
  run.disabled = true
  filesInput.disabled = true
  cancel.disabled = false
  controller = new AbortController()
  try {
    const files = Array.from(filesInput.files)
    const metadata = files.find((file) => file.name === 'metadata.json')
    if (!metadata || metadata.size > 2_000_000) throw new Error('Choose one capture folder with metadata.json.')
    const capture = JSON.parse(await metadata.text())
    if (!Array.isArray(capture.frames) || capture.frames.length < 8 || capture.frames.length > 150) throw new Error('Expected 8–150 calibrated source photos.')
    capture.frames = capture.frames.map((frame) => {
      const basename = decodeURIComponent((frame.uri ?? frame.path ?? frame.fileUrl ?? '').split('/').at(-1))
      const candidates = files.filter((file) => file.name === basename)
      if (candidates.length !== 1 || !/\.jpe?g$/i.test(basename)) throw new Error(`Missing or ambiguous source ${basename}`)
      const uri = URL.createObjectURL(candidates[0])
      references.push(uri)
      return { ...frame, uri }
    })
    const started = performance.now()
    const result = await composeGuidedPanorama(capture, (progress) => {
      status.textContent = `${progress.phase}: ${progress.completed} of ${progress.total}`
    }, Number(document.querySelector('#width').value), controller.signal)
    if (outputUrl) URL.revokeObjectURL(outputUrl)
    outputUrl = URL.createObjectURL(result.viewer)
    output.src = outputUrl
    output.hidden = false
    download.href = outputUrl
    download.hidden = false
    status.textContent = JSON.stringify({ frames: capture.frames.length, width: result.viewerWidth, height: result.viewerHeight,
      seconds: Math.round((performance.now() - started) / 10) / 100, bytes: result.viewer.size,
      note: 'Actual shared-compositor result. Visual inspection is required; successful encoding does not prove good alignment.' }, null, 2)
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    references.forEach((uri) => URL.revokeObjectURL(uri))
    run.disabled = false
    filesInput.disabled = false
    cancel.disabled = true
    controller = undefined
  }
})
