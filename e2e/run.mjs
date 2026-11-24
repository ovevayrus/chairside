// Simulator e2e for the glasses app.
//
//   npm run e2e                       full run (US-011): pairing, a DM card, a
//                                     one-tap booking, the stale-slot case, a
//                                     backend restart and the root exit request;
//                                     writes docs/evidence/e2e-full.md + PNGs
//   npm run e2e -- --smoke            US-005 root-page checks (docs/SPIKES.md S3)
//   npm run e2e -- --smoke --spike    then the dev spike page (?spike=1)
//
// Starts the backend in TEST MODE (DEV_INJECT=1, fake Telegram and fake
// calendar, fresh temp database), the Vite dev server and the Even Hub
// simulator, and drives the simulator through its automation API. Only the
// process trees this run started are killed: in a finally, on Ctrl+C and on a
// crash.
import { Backend } from './lib/backend.mjs'
import { fullRun } from './lib/full.mjs'
import {
  assertPortsFree,
  packageBin,
  root,
  startVite,
  step,
} from './lib/harness.mjs'
import { run, stopAll } from './lib/processes.mjs'
import { s3Run } from './lib/s3.mjs'
import { findSimulator } from './lib/simulator.mjs'

let interrupted = false
let backend

async function main() {
  const args = process.argv.slice(2)
  const flags = {
    smoke: args.includes('--smoke'),
    spike: args.includes('--spike'),
  }
  const unknown = args.filter((arg) => arg !== '--smoke' && arg !== '--spike')
  if (unknown.length > 0) {
    console.error(
      'usage: npm run e2e [-- --smoke] [--spike]   (no flags: the full run)',
    )
    process.exitCode = 2
    return
  }
  await assertPortsFree(['backend', 'vite', 'automation'])
  const simulator = findSimulator()

  step('building @chairside/shared (the backend imports its dist)')
  await run(
    'tsc',
    process.execPath,
    [packageBin('typescript', 'tsc'), '-b', 'packages/shared'],
    { cwd: root, windowsHide: true },
  )
  backend = new Backend()
  await backend.start()
  await startVite()

  if (!flags.smoke && !flags.spike) {
    await fullRun(simulator, backend)
    step('PASS (full run; see docs/evidence/e2e-full.md)')
    return
  }
  step(await s3Run(simulator, backend, flags, args, () => interrupted))
}

async function cleanup() {
  await stopAll()
  await backend?.dispose().catch(() => {})
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    if (interrupted) return
    interrupted = true
    console.error(`\n[e2e] ${signal}: stopping the processes this run started`)
    cleanup().finally(() => process.exit(130))
  })
}
process.on('uncaughtException', (error) => {
  console.error(`[e2e] crashed: ${error.stack ?? error}`)
  cleanup().finally(() => process.exit(1))
})

try {
  await main()
} catch (error) {
  if (!interrupted) {
    console.error(`[e2e] FAIL: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  if (!interrupted) {
    await cleanup()
    process.exit(process.exitCode ?? 0)
  }
}
