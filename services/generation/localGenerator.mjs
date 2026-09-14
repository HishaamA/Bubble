import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** All inference runs in a local Python process, never an external image API. */
export function createLocalGenerator({ root, python = process.env.GENERATION_PYTHON || join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python') }) {
  let cachedHealth
  let healthTime = 0
  function runProcess(args, { timeoutMs, capture = false }) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'services.generation.local_pipeline', ...args], {
        cwd: root, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TRANSFORMERS_OFFLINE: '1' },
      })
      let output = ''
      let timedOut = false
      if (capture) child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16_384) })
      if (capture) child.stderr.on('data', () => { /* Health failures expose no local paths or secrets. */ })
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else child.kill('SIGTERM')
        // Keep the GPU lock until the actual child closes, including Windows'
        // launcher descendants. A requested termination is not completion.
      }, timeoutMs)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (timedOut) reject(new Error('The local model exceeded its time limit.'))
        else if (code === 0) resolve(output)
        else reject(new Error('The local generation process could not finish.'))
      })
    })
  }
  return {
    model: 'FLUX.2-klein-base-4B + 360 ERP Outpaint LoRA (local NF4)',
    async health() {
      if (cachedHealth && Date.now() - healthTime < 15_000) return cachedHealth
      try {
        const text = await runProcess(['--check'], { timeoutMs: 20_000, capture: true })
        const value = JSON.parse(text.trim().split('\n').at(-1))
        cachedHealth = { ready: value.ready === true, reason: value.reason ?? value.error, device: value.device }
      } catch {
        cachedHealth = { ready: false, reason: 'Set up the free local panorama model, then restart the generation service.' }
      }
      healthTime = Date.now()
      return cachedHealth
    },
    async run(directory) {
      await runProcess(['--job-dir', directory], { timeoutMs: 30 * 60_000 })
    },
  }
}
