import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createGenerationServer } from './server.mjs'

const id = '96a2488e-bb52-4a30-ab66-836feb144244'
const other = '75e0267c-9a41-4e9e-a37d-737df7d1f6fa'
function payload(override = {}) {
  return { id, prompt: 'A bright family room', consent: true, azimuths: [0], photos: [{ type: 'image/jpeg', data: Buffer.from('reference fixture').toString('base64') }], ...override }
}
async function fixture(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'bubble-generation-'))
  const generator = options.generator ?? {
    model: 'test-local-model', health: async () => ({ ready: true }),
    run: async (folder) => { await writeFile(join(folder, 'panorama.png'), Buffer.from('panorama fixture')) },
  }
  const server = await createGenerationServer({ directory, generator })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/generation`
  const post = (value, headers = {}) => fetch(`${base}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bubble-Generation': '1', ...headers }, body: JSON.stringify(value) })
  return { directory, base, post }
}
async function terminal(base) {
  for (let index = 0; index < 30; index++) {
    const job = await (await fetch(`${base}/jobs/${id}`)).json()
    if (['completed', 'failed'].includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Test job did not finish')
}
test('unconfigured model fails closed without accepting any photos for generation', async (t) => {
  let calls = 0
  const { base, post } = await fixture(t, { generator: { model: 'local', health: async () => ({ ready: false, reason: 'Model not installed' }), run: async () => { calls++ } } })
  assert.equal((await (await fetch(`${base}/health`)).json()).ready, false)
  assert.equal((await post(payload())).status, 503)
  assert.equal(calls, 0)
})
test('requires consent, bounded photos and unique cardinal directions', async (t) => {
  const { post } = await fixture(t)
  for (const input of [payload({ consent: false }), payload({ id: '../secret' }), payload({ photos: [] }), payload({ azimuths: [8] }), payload({ photos: [payload().photos[0], payload().photos[0]], azimuths: [0, 0] })]) {
    assert.equal((await post(input)).status, 400)
  }
})
test('rejects cross-origin writes and unsafe Host headers', async (t) => {
  const { post, base } = await fixture(t)
  assert.equal((await post(payload(), { Origin: 'https://untrusted.example' })).status, 403)
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/health`, { headers: { Host: 'rebind.example' } }, (response) => { response.resume(); resolve(response.statusCode) })
    request.on('error', reject)
    request.end()
  })
  assert.equal(status, 403)
  assert.equal((await post(payload(), { 'X-Bubble-Generation': '' })).status, 403)
})
test('rejects malformed bodies and invalid camera-angle metadata before generation', async (t) => {
  const { post } = await fixture(t)
  for (const value of [null, [], payload({ photos: [null] }), payload({ horizontalFovs: [] }), payload({ horizontalFovs: [null] }), payload({ horizontalFovs: [24] }), payload({ horizontalFovs: [111] }), payload({ horizontalFovs: [40, 60] })]) {
    assert.equal((await post(value)).status, 400)
  }
})
test('saves references first and returns only locally generated result bytes', async (t) => {
  const { base, post, directory } = await fixture(t)
  assert.equal((await post(payload({ horizontalFovs: [40.7] }))).status, 202)
  const job = await terminal(base)
  assert.equal(job.status, 'completed')
  assert.equal(job.provider, 'local')
  assert.equal(await readFile(join(directory, id, 'reference-0'), 'utf8'), 'reference fixture')
  assert.deepEqual(JSON.parse(await readFile(join(directory, id, 'job.json'), 'utf8')).horizontalFovs, [40.7])
  assert.equal(await (await fetch(`${base}/jobs/${id}/panorama`)).text(), 'panorama fixture')
  assert.equal('prompt' in job, false)
  assert.equal('directory' in job, false)
  assert.equal((await fetch(`${base}/jobs`)).status, 404)
})
test('reusing an accepted id is idempotent and does not regenerate', async (t) => {
  let calls = 0
  const { base, post } = await fixture(t, { generator: { model: 'local', health: async () => ({ ready: true }), run: async (folder) => { calls++; await writeFile(join(folder, 'panorama.png'), 'result') } } })
  await post(payload())
  await terminal(base)
  assert.equal((await post(payload())).status, 200)
  assert.equal(calls, 1)
})
test('only one model process runs at a time', async (t) => {
  let finish
  let healthCalls = 0
  const wait = new Promise((resolve) => { finish = resolve })
  const { base, post } = await fixture(t, { generator: { model: 'local', health: async () => { healthCalls++; return { ready: true } }, run: async (folder) => { await wait; await writeFile(join(folder, 'panorama.png'), 'result') } } })
  await post(payload())
  const health = await (await fetch(`${base}/health`)).json()
  assert.equal(health.ready, false)
  assert.match(health.reason, /another scene/)
  assert.equal((await post(payload({ id: other }))).status, 409)
  assert.equal(healthCalls, 1)
  finish()
  await terminal(base)
})
test('failed inference preserves references and never supplies a panorama', async (t) => {
  const { base, post, directory } = await fixture(t, { generator: { model: 'local', health: async () => ({ ready: true }), run: async () => { throw new Error('GPU out of memory') } } })
  await post(payload())
  assert.equal((await terminal(base)).status, 'failed')
  assert.equal((await fetch(`${base}/jobs/${id}/panorama`)).status, 409)
  assert.equal(await readFile(join(directory, id, 'reference-0'), 'utf8'), 'reference fixture')
})
test('restart marks unfinished work interrupted; it does not silently rerun it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-generation-restart-'))
  await mkdir(join(directory, id))
  await writeFile(join(directory, id, 'job.json'), JSON.stringify({ id, status: 'running', stage: 'Generating', model: 'local' }))
  let calls = 0
  const { base } = await fixture(t, { directory, generator: { model: 'local', health: async () => ({ ready: true }), run: async () => { calls++ } } })
  const job = await (await fetch(`${base}/jobs/${id}`)).json()
  assert.equal(job.status, 'failed')
  assert.match(job.error, /restarted/)
  assert.equal(calls, 0)
})

for (const metadata of ['missing', 'malformed']) {
  test(`restart recovers an orphan with ${metadata} metadata without deleting references or regenerating`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'bubble-generation-orphan-'))
    const folder = join(directory, id)
    await mkdir(folder)
    await writeFile(join(folder, 'reference-0'), 'irreplaceable reference fixture')
    await writeFile(join(folder, 'panorama.png'), 'unfinished output must not be served')
    if (metadata === 'malformed') await writeFile(join(folder, 'job.json'), '{"status":')
    let calls = 0
    const { base, post } = await fixture(t, {
      directory,
      generator: { model: 'local-fixture', health: async () => ({ ready: true }), run: async () => { calls++ } },
    })
    const response = await fetch(`${base}/jobs/${id}`)
    assert.equal(response.status, 200)
    const job = await response.json()
    assert.equal(job.id, id)
    assert.equal(job.status, 'failed')
    assert.match(job.error, /original photos|new attempt/)
    assert.equal((await fetch(`${base}/jobs/${id}/panorama`)).status, 409)
    const retry = await post(payload())
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).status, 'failed')
    assert.equal(calls, 0)
    assert.equal(await readFile(join(folder, 'reference-0'), 'utf8'), 'irreplaceable reference fixture')
    assert.equal(await readFile(join(folder, 'panorama.png'), 'utf8'), 'unfinished output must not be served')
    const persisted = JSON.parse(await readFile(join(folder, 'job.json'), 'utf8'))
    assert.equal(persisted.status, 'failed')
    assert.equal(persisted.id, id)
  })
}
