import { Human } from '@vladmandic/human'
import { createFaceHumanConfig, extractFaceDetections, faceInferenceSize } from '../src/features/journal/people/faceRecognitionPipeline.ts'
import { faceResSimilarity } from '../src/features/journal/people/peopleTimelineHelpers.ts'

const status = document.getElementById('status')
const backend = new URL(location.href).searchParams.get('backend') === 'webgl' ? 'webgl' : 'wasm'
document.getElementById('run').textContent = `Test bundled ${backend.toUpperCase()} engine`
document.getElementById('run').addEventListener('click', async (event) => {
  event.target.disabled = true
  const report = { state: 'loading', backend, steps: [] }
  const show = () => { status.textContent = JSON.stringify(report, null, 2) }
  show()
  try {
    const begin = performance.now()
    const human = new Human({ ...createFaceHumanConfig(backend), cacheModels: false })
    await human.init()
    report.version = human.tf.version
    report.actualBackend = human.tf.getBackend()
    await human.load()
    report.loadMs = Math.round(performance.now() - begin)
    show()
    const illustration = new Image()
    illustration.src = '/assets/journal/demo/demo-album-sunday.png'
    await illustration.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 1280; canvas.height = 960
    const context = canvas.getContext('2d')
    context.fillStyle = '#eeeeee'; context.fillRect(0, 0, 1280, 960)
    let demoFaces = []
    for (const [name, image] of [['plain wall', canvas], ['bundled demo', illustration], ['bundled demo warm', illustration]]) {
      const started = performance.now()
      const size = faceInferenceSize(image.naturalWidth || image.width, image.naturalHeight || image.height)
      const result = await human.detect(image, { filter: size })
      const faces = extractFaceDetections(result, size)
      report.steps.push({ name, ms: Math.round(performance.now() - started), faces: faces.faces.length,
        descriptorLengths: faces.faces.map((face) => face.embedding.length) })
      if (image === illustration) demoFaces = faces.faces
      show()
    }
    // Only the bundled fictional demo's descriptors, never gallery data. A
    // fresh navigation keeps TensorFlow backend state isolated for comparison.
    const fixtureKey = 'bubble:developer-only:demo-fixture-wasm'
    if (backend === 'wasm') sessionStorage.setItem(fixtureKey, JSON.stringify(demoFaces.map((face) => face.embedding)))
    else {
      const previous = JSON.parse(sessionStorage.getItem(fixtureKey) || '[]')
      report.compatibility = {
        wasmFaces: previous.length, webglFaces: demoFaces.length,
        bestFaceSimilarities: previous.map((embedding) => Math.max(0, ...demoFaces.map((face) => faceResSimilarity(embedding, face.embedding)))),
      }
      sessionStorage.removeItem(fixtureKey)
    }
    report.state = 'passed'
  } catch (error) {
    report.state = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
  }
  show()
  event.target.disabled = false
})
