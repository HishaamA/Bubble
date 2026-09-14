import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const python = process.env.STITCH_PYTHON || resolve(
  root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
)
if (!existsSync(python)) {
  console.error('Set up the AI worker first: see services/stitcher/README.md.')
  process.exit(1)
}

const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    // Windows' venv python.exe is a launcher with its own child process.
    // Stopping only that launcher would leave the worker holding port 8787.
    if (process.platform === 'win32' && child.pid && child.exitCode === null) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      })
    } else {
      child.kill('SIGTERM')
    }
  }
  process.exitCode = code
}
function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  children.push(child)
  child.once('error', (error) => { console.error(error.message); stop(1) })
  child.once('exit', (code) => { if (!stopping) stop(code || 0) })
}

start(python, [
  '-m', 'uvicorn', 'services.stitcher.server:app',
  '--host', '127.0.0.1', '--port', '8787',
], { TORCH_HOME: process.env.TORCH_HOME || resolve(root, '.models') })

if (!process.argv.includes('--worker-only')) {
  start(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--mode', 'demo'])
}

process.once('SIGINT', () => stop())
process.once('SIGTERM', () => stop())
