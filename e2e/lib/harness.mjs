// Helpers shared by the e2e runner and the font measurement script: npm bin
// lookup, the Vite dev server, simulator launch and display/console polling.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { compare, decode } from './frames.mjs'
import { fatal, portTaken, start, stop, waitFor } from './processes.mjs'
import { Simulator } from './simulator.mjs'

export const root = fileURLToPath(new URL('../..', import.meta.url))
export const ports = { backend: 8787, vite: 5173, automation: 9898 }
export const appUrl = `http://localhost:${ports.vite}`
export const apiBase = `http://localhost:${ports.backend}`
export const READY_BUDGET_MS = 10_000
// At info level the simulator logs each bridge call and every input it drops.
const SIMULATOR_LOG = 'evenhub_simulator_lib=info'

export const step = (message) => console.log(`[e2e] ${message}`)

export function packageBin(name, bin) {
  const manifestPath = createRequire(import.meta.url).resolve(
    `${name}/package.json`,
  )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relative =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[bin]
  return join(dirname(manifestPath), relative)
}

export async function httpOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  return response.ok
}

/** Fails before anything starts when a port this run needs is taken. */
export async function assertPortsFree(names) {
  for (const name of names) {
    if (await portTaken(ports[name])) {
      throw new Error(
        `port ${ports[name]} (${name}) is already in use: stop that process first; this runner only stops what it starts`,
      )
    }
  }
}

export async function startVite(env = {}) {
  step(`starting Vite on :${ports.vite}`)
  const proc = start(
    'vite',
    process.execPath,
    [packageBin('vite', 'vite'), '--port', String(ports.vite), '--strictPort'],
    {
      cwd: join(root, 'apps', 'glasses'),
      env: { ...process.env, VITE_API_BASE: apiBase, ...env },
      windowsHide: true,
    },
  )
  await waitFor('the Vite dev server', 30_000, () =>
    httpOk(`http://127.0.0.1:${ports.vite}/`),
  )
  return proc
}

/** Waits for the display to leave `from` (if given), then for two identical frames in a row. */
export async function settledFrame(sim, from, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let current = decode(await sim.screenshot())
  while (
    from &&
    compare(from, current).changed === 0 &&
    Date.now() < deadline
  ) {
    await delay(100)
    current = decode(await sim.screenshot())
  }
  for (;;) {
    await delay(200)
    const next = decode(await sim.screenshot())
    if (compare(current, next).changed === 0) return next
    if (Date.now() > deadline + 5000) {
      throw new Error('the glasses display did not settle')
    }
    current = next
  }
}

/** Polls the simulator console until an entry at or after index `from` matches. */
export function consoleMatch(sim, what, pattern, from = 0, timeoutMs = 5000) {
  return waitFor(`"${what}" in the simulator console`, timeoutMs, async () => {
    await sim.pollConsole()
    return sim.find(pattern, from)
  })
}

/** The app's own console lines ([chairside] ...) from index `from` on. */
export function appLog(sim, from = 0) {
  return sim.entries
    .slice(from)
    .map((entry) => entry.message)
    .filter((message) => message.startsWith('[chairside]'))
}

/**
 * Launches the simulator on `url` and waits for "[chairside] ready". Returns
 * { sim, proc, pingMs, readyMs }; the caller stops `proc` (stop() is idempotent).
 */
export async function launchSimulator(simulator, url) {
  await waitFor(`port ${ports.automation} to be free`, 10_000, async () => {
    return !(await portTaken(ports.automation))
  })
  step(`launching the simulator on ${url}`)
  const launchedAt = Date.now()
  const args = [url, '--automation-port', String(ports.automation)]
  const proc = start(
    'simulator',
    simulator.command,
    simulator.shell ? args.map((arg) => `"${arg}"`) : args,
    {
      cwd: tmpdir(),
      shell: simulator.shell,
      env: { ...process.env, RUST_LOG: SIMULATOR_LOG },
    },
  )
  try {
    const sim = new Simulator(ports.automation)
    await waitFor('the simulator automation API (/api/ping)', 30_000, () =>
      sim.ping(),
    )
    const pingMs = Date.now() - launchedAt
    await waitFor(
      `"[chairside] ready" within ${READY_BUDGET_MS} ms of launch`,
      Math.max(READY_BUDGET_MS - pingMs, 0),
      async () => {
        await sim.pollConsole()
        const failed = sim.find(/\[chairside\] startup( page)? failed/)
        if (failed) throw fatal(`the app failed to start: ${failed.message}`)
        return sim.find(/\[chairside\] ready/)
      },
      100,
    )
    const readyMs = Date.now() - launchedAt
    step(
      `ready ${readyMs} ms after launch (automation API up after ${pingMs} ms)`,
    )
    return { sim, proc, pingMs, readyMs }
  } catch (error) {
    await stop(proc)
    throw error
  }
}

/** Simulator log lines (bridge calls, dropped inputs) without the timestamp prefix. */
export function simulatorLines(proc, pattern) {
  return proc.lines
    .filter((line) => pattern.test(line))
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, ''))
}
