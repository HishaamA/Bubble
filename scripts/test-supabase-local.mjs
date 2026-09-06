#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const argumentsSet = new Set(process.argv.slice(2))
if (argumentsSet.has('--help')) {
  console.log(`Usage: pnpm test:supabase:local -- [options]

Options:
  --keep-running          Leave a stack created by this run available for debugging.
  --reuse-running-stack   Reset and test an existing local stack.
  --help                  Show this help.`)
  process.exit(0)
}
const reuseRunningStack = argumentsSet.has('--reuse-running-stack')
const keepRunningStack = argumentsSet.has('--keep-running')
const supportedArguments = new Set([
  '--keep-running',
  '--reuse-running-stack',
])

const unsupportedArgument = [...argumentsSet].find(
  (argument) => !supportedArguments.has(argument),
)
if (unsupportedArgument) {
  console.error(`Unknown argument: ${unsupportedArgument}`)
  process.exit(2)
}

const supabaseCommand = ['pnpm', 'exec', 'supabase']
const functionUrl = 'http://127.0.0.1:54321/functions/v1/flight-status'
const localWebOrigin = 'http://localhost:5173'
const commandEnvironment = {
  ...process.env,
  // Supabase telemetry is not part of a deterministic local test run.
  SUPABASE_TELEMETRY_DISABLED: '1',
}

let functionServer = null
let stackStartedByThisRun = false
let cleanupStarted = false

/** Runs a foreground command and throws when it does not complete successfully. */
function runCommand(command, commandArguments, options = {}) {
  const result = spawnSync(command, commandArguments, {
    cwd: process.cwd(),
    env: commandEnvironment,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const details = options.quiet
      ? `\n${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
      : ''
    throw new Error(
      `${command} ${commandArguments.join(' ')} exited with status ${result.status}.${details}`,
    )
  }
  return result
}

/** Fails early with an actionable message when a required executable is absent. */
function requireCommand(command, installationHint) {
  const result = spawnSync(command, ['--version'], {
    env: commandEnvironment,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${command} is required. ${installationHint}`)
  }
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} --version failed.`)
  }
}

/** Stops the function worker and removes only a stack created by this command. */
async function cleanup() {
  if (cleanupStarted) return
  cleanupStarted = true

  if (functionServer && functionServer.exitCode === null) {
    functionServer.kill('SIGTERM')
    await Promise.race([once(functionServer, 'exit'), delay(5_000)])
    if (functionServer.exitCode === null) functionServer.kill('SIGKILL')
  }

  if (stackStartedByThisRun && !keepRunningStack) {
    runCommand(
      supabaseCommand[0],
      [...supabaseCommand.slice(1), 'stop', '--no-backup'],
      { allowFailure: true },
    )
  }
}

/** Waits for the local Edge worker instead of relying on timing-sensitive sleeps. */
async function waitForFunctionServer() {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (functionServer?.exitCode !== null) {
      throw new Error('The local Edge Function worker exited before becoming ready.')
    }
    try {
      const response = await fetch(functionUrl, {
        method: 'OPTIONS',
        headers: { Origin: localWebOrigin },
      })
      if (response.status === 204) return
    } catch {
      // The worker is still compiling or binding its local port.
    }
    await delay(500)
  }
  throw new Error('Timed out waiting for the local Edge Function worker.')
}

/** Exercises CORS, request parsing, and the unauthenticated rejection boundary. */
async function testFunctionBoundary() {
  const preflightResponse = await fetch(functionUrl, {
    method: 'OPTIONS',
    headers: { Origin: localWebOrigin },
  })
  const allowedOrigin = preflightResponse.headers.get(
    'access-control-allow-origin',
  )
  if (
    preflightResponse.status !== 204
    || (allowedOrigin !== localWebOrigin && allowedOrigin !== '*')
  ) {
    throw new Error(
      'The flight-status CORS preflight contract failed '
      + `(status ${preflightResponse.status}, origin ${String(allowedOrigin)}).`,
    )
  }

  // Local Kong normalizes allowed CORS responses to `*`, so the browser-facing
  // header cannot prove the function's allow-list. Exercise the handler with a
  // hostile origin as a separate request to preserve that security boundary.
  const untrustedOriginResponse = await fetch(functionUrl, {
    method: 'POST',
    headers: {
      Origin: 'https://untrusted.example',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const untrustedOriginBody = await untrustedOriginResponse.json()
  if (
    untrustedOriginResponse.status !== 403
    || untrustedOriginBody?.error !== 'Origin is not allowed.'
  ) {
    throw new Error('The flight-status origin allow-list contract failed.')
  }

  const invalidJsonResponse = await fetch(functionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  if (invalidJsonResponse.status !== 400) {
    throw new Error('The flight-status invalid-JSON contract failed.')
  }

  const unauthenticatedResponse = await fetch(functionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'refresh',
      flightId: '10000000-0000-4000-8000-000000000001',
    }),
  })
  if (unauthenticatedResponse.status !== 401) {
    throw new Error('The flight-status authentication boundary failed.')
  }
}

/** Runs the complete disposable backend test sequence. */
async function main() {
  requireCommand(
    'docker',
    'Install and start Docker Desktop: https://docs.docker.com/desktop/',
  )
  requireCommand('deno', 'Install Deno: https://docs.deno.com/runtime/getting_started/installation/')
  requireCommand('pnpm', 'Enable Corepack and run pnpm install.')

  runCommand('docker', ['info'], { quiet: true })
  runCommand(
    supabaseCommand[0],
    [...supabaseCommand.slice(1), '--version'],
    { quiet: true },
  )

  const stackStatus = runCommand(
    supabaseCommand[0],
    [...supabaseCommand.slice(1), 'status'],
    { allowFailure: true, quiet: true },
  )
  const stackWasAlreadyRunning = stackStatus.status === 0
  if (stackWasAlreadyRunning && !reuseRunningStack) {
    throw new Error(
      'A local Supabase stack is already running. Stop it first, or pass '
      + '--reuse-running-stack to explicitly allow its database to be reset.',
    )
  }

  if (!stackWasAlreadyRunning) {
    // Mark ownership before startup so cleanup also handles a partial start.
    stackStartedByThisRun = true
    runCommand(
      supabaseCommand[0],
      [...supabaseCommand.slice(1), 'start'],
    )
  }

  // A reset proves every migration and seed file can build a clean database.
  runCommand(
    supabaseCommand[0],
    [...supabaseCommand.slice(1), 'db', 'reset', '--local'],
  )

  // With no path argument, Supabase discovers every pgTAP file in supabase/tests.
  runCommand(
    supabaseCommand[0],
    [...supabaseCommand.slice(1), 'test', 'db', '--local'],
  )

  runCommand('deno', [
    'test',
    'supabase/functions/flight-status/providerHelpers_test.ts',
  ])

  functionServer = spawn(
    supabaseCommand[0],
    [
      ...supabaseCommand.slice(1),
      'functions',
      'serve',
      'flight-status',
      '--no-verify-jwt',
    ],
    {
      cwd: process.cwd(),
      env: commandEnvironment,
      stdio: 'inherit',
    },
  )
  await waitForFunctionServer()
  await testFunctionBoundary()

  console.log('\nSupabase migrations, pgTAP, auth, and Edge Function checks passed.')
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15)))
  })
}

try {
  await main()
} catch (error) {
  console.error(`\nSupabase integration test failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await cleanup()
}
