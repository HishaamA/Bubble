import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createLocalGenerator } from './localGenerator.mjs'

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_PHOTO_BYTES = 8 * 1024 * 1024
const MAX_BODY_BYTES = 45 * 1024 * 1024
const SAFE_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'https://localhost', 'capacitor://localhost'])
const BUSY_MESSAGE = 'Your computer is working on another scene. Try again when it finishes.'
function progressLabel(progress) {
  const labels = {
    prepare: 'Placing your photos around the sphere',
    encoding: 'Understanding your scene description',
    loading: 'Loading the panorama model on your computer',
    saving: 'Saving your generated scene',
    complete: 'Finishing your scene',
  }
  if (progress.stage === 'generating') {
    const done = Number(progress.completed)
    const total = Number(progress.total)
    return Number.isInteger(done) && Number.isInteger(total) && total > 0 && done >= 0 && done <= total
      ? `Imagining your 360° scene · ${done} of ${total} steps`
      : 'Imagining your 360° scene'
  }
  return labels[progress.stage]
}
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
function publicJob(job) {
  return {
    id: job.id, status: job.status, stage: job.stage, error: job.error,
    provider: 'local', model: job.model, referenceCount: job.referenceCount,
    createdAt: job.createdAt, generatedAt: job.generatedAt,
  }
}

/** Loopback-only companion, with unguessable job IDs and no job-list endpoint.
 * Original drafts remain on the phone; this computer keeps its working copies. */
export async function createGenerationServer({ directory, generator } = {}) {
  if (!directory || !generator) throw new Error('A private job directory and local generator are required.')
  await mkdir(directory, { recursive: true })
  const jobs = new Map()
  const active = new Map()
  let accepting = false
  async function persist(job) {
    const folder = join(directory, job.id)
    await writeFile(join(folder, 'job.next.json'), JSON.stringify(job), { mode: 0o600 })
    await rename(join(folder, 'job.next.json'), join(folder, 'job.json'))
    jobs.set(job.id, job)
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue
    try {
      const job = JSON.parse(await readFile(join(directory, entry.name, 'job.json'), 'utf8'))
      if (job.id !== entry.name) continue
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'failed'
        job.stage = 'Generation was interrupted'
        job.error = 'The generation computer restarted. Your reference photos are saved; you can try again.'
        await persist(job)
      }
      jobs.set(job.id, job)
    } catch {
      // Even a crash immediately after mkdir leaves a recoverable failed intent.
      // Never remove a directory that may already contain reference photos.
      const interrupted = { id: entry.name, status: 'failed', stage: 'Draft transfer was interrupted',
        error: 'Your phone keeps the original photos. Start a new attempt to transfer them again.',
        model: generator.model, createdAt: new Date().toISOString() }
      jobs.set(entry.name, interrupted)
      await persist(interrupted).catch(() => undefined)
    }
  }
  async function execute(job) {
    try {
      job.status = 'running'
      job.stage = 'Loading the panorama model on your computer'
      await persist(job)
      await generator.run(join(directory, job.id))
      const bytes = await readFile(join(directory, job.id, 'panorama.png'))
      if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('Invalid output size.')
      job.status = 'completed'
      job.stage = 'Ready to review'
      job.generatedAt = new Date().toISOString()
      delete job.error
    } catch {
      job.status = 'failed'
      job.stage = 'Generation could not finish'
      job.error = 'Your computer could not finish this scene. Your photos are safe. Check the generation terminal and try again.'
    }
    await persist(job)
  }
  async function readJson(request) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new RequestError('JSON is required.', 415)
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new RequestError('These photos are too large.', 413)
      chunks.push(chunk)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new RequestError('Invalid request.') }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const origin = request.headers.origin
    const host = request.headers.host ?? ''
    // Vite uses changeOrigin; Android testing can use adb reverse. Do not expose
    // this companion as a public service without real authentication and TLS.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) || (origin && !SAFE_ORIGINS.has(origin))) {
      response.writeHead(403).end(); return
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bubble-Generation')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.writeHead(204).end(); return
    }
    const send = (status, value) => {
      response.setHeader('Content-Type', 'application/json')
      response.writeHead(status).end(JSON.stringify(value))
    }
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (request.method === 'GET' && path === '/api/generation/health') {
        // A CUDA health process also consumes GPU memory. Never launch one
        // alongside the inference process just to answer a connection check.
        const health = accepting || active.size ? { ready: false, reason: BUSY_MESSAGE } : await generator.health()
        send(200, { ...health, provider: 'local', model: generator.model, maxPhotos: 4 }); return
      }
      if (request.method === 'POST' && path === '/api/generation/jobs') {
        if (request.headers['x-bubble-generation'] !== '1') throw new RequestError('Use the Bubble generation screen.', 403)
        const input = await readJson(request)
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError('Invalid generation request.')
        if (!ID.test(input.id ?? '')) throw new RequestError('A valid draft ID is required.')
        const existing = jobs.get(input.id)
        if (existing) { send(200, publicJob(existing)); return }
        if (input.consent !== true) throw new RequestError('Confirm AI reconstruction and transfer to your computer first.')
        if (typeof input.prompt !== 'string' || input.prompt.length > 2_000) throw new RequestError('Keep the scene description under 2,000 characters.')
        if (!Array.isArray(input.photos) || input.photos.length < 1 || input.photos.length > 4) throw new RequestError('Choose one to four photos.')
        if (!Array.isArray(input.azimuths) || input.azimuths.length !== input.photos.length || input.azimuths.some((angle) => ![0, 90, 180, 270].includes(angle))) throw new RequestError('Choose a direction for every reference photo.')
        if (new Set(input.azimuths).size !== input.azimuths.length) throw new RequestError('Use one photo per direction.')
        if (input.horizontalFovs !== undefined && (!Array.isArray(input.horizontalFovs) || input.horizontalFovs.length !== input.photos.length || input.horizontalFovs.some((angle) => !Number.isFinite(angle) || angle < 25 || angle > 110))) throw new RequestError('The reference camera angles are invalid. Prepare these photos again.')
        const photos = input.photos.map((photo) => {
          if (!photo || typeof photo !== 'object') throw new RequestError('Invalid reference photo.')
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || typeof photo.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(photo.data)) throw new RequestError('Use JPEG, PNG, or WebP reference photos.')
          const bytes = Buffer.from(photo.data, 'base64')
          if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw new RequestError('Each reference must be under 8 MB.', 413)
          return { bytes, type: photo.type }
        })
        if (accepting || active.size) throw new RequestError(BUSY_MESSAGE, 409)
        const health = await generator.health()
        if (!health.ready) throw new RequestError(health.reason || 'Set up the local panorama model first.', 503)
        if (accepting || active.size) throw new RequestError(BUSY_MESSAGE, 409)
        accepting = true
        try {
          const folder = join(directory, input.id)
          await mkdir(folder) // exclusive: a repeated ID never starts duplicate work
          const job = {
            id: input.id, status: 'queued', stage: 'Reference photos saved',
            prompt: input.prompt, referenceCount: photos.length,
            referenceTypes: photos.map((photo) => photo.type), azimuths: input.azimuths,
            horizontalFovs: input.horizontalFovs,
            model: generator.model, createdAt: new Date().toISOString(),
          }
          await persist(job)
          try {
            for (let index = 0; index < photos.length; index++) await writeFile(join(folder, `reference-${index}`), photos[index].bytes, { mode: 0o600 })
          } catch {
            job.status = 'failed'
            job.stage = 'Could not save reference copies'
            job.error = 'Check free space on your generation computer. The original photos stay on your phone.'
            await persist(job)
            send(200, publicJob(job)); return
          }
          send(202, publicJob(job))
          const work = execute(job)
          active.set(job.id, work)
          void work.catch(() => { /* Keep durable intent for restart recovery. */ }).finally(() => active.delete(job.id))
        } finally { accepting = false }
        return
      }
      const match = path.match(/^\/api\/generation\/jobs\/([^/]+)(\/panorama)?$/)
      if (request.method === 'GET' && match && ID.test(match[1])) {
        const job = jobs.get(match[1])
        if (!job) throw new RequestError('This job was not found on this generation computer. Your local photos remain saved.', 404)
        if (match[2]) {
          if (job.status !== 'completed') throw new RequestError('The scene is not ready yet.', 409)
          const bytes = await readFile(join(directory, job.id, 'panorama.png'))
          response.setHeader('Content-Type', 'image/png')
          response.writeHead(200).end(bytes)
        } else {
          const visible = publicJob(job)
          if (job.status === 'running') {
            try {
              const progress = JSON.parse(await readFile(join(directory, job.id, 'progress.json'), 'utf8'))
              visible.stage = progressLabel(progress) ?? visible.stage
            } catch { /* The first model-loading stage remains visible. */ }
          }
          send(200, visible)
        }
        return
      }
      throw new RequestError('Not found.', 404)
    } catch (error) {
      if (!response.headersSent) send(error.status ?? 500, { error: error instanceof RequestError ? error.message : 'The generation computer could not complete this request. Your originals have not been removed.' })
      else response.end()
    }
  })
  server.requestTimeout = 180_000
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const server = await createGenerationServer({
    directory: join(root, 'private-media', 'generation-jobs'), generator: createLocalGenerator({ root }),
  })
  server.listen(8788, '127.0.0.1', () => console.log('Bubble local generation: http://127.0.0.1:8788 — no paid APIs'))
}
