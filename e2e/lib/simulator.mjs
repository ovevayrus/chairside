// The Even Hub simulator: locating its binary and driving its automation API
// (GET /api/ping, /api/console, /api/screenshot/glasses; POST /api/input).
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

/**
 * The native simulator binary, found through the global npm install on PATH so
 * it can be spawned without a shell. Falls back to the npm shim (shell: true on
 * Windows). EVENHUB_SIMULATOR overrides the binary path.
 */
export function findSimulator() {
  if (process.env.EVENHUB_SIMULATOR) {
    return {
      command: process.env.EVENHUB_SIMULATOR,
      shell: false,
      version: 'unknown',
    }
  }
  const windows = process.platform === 'win32'
  const shimName = windows ? 'evenhub-simulator.cmd' : 'evenhub-simulator'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const shim = dir && join(dir, shimName)
    if (!shim || !existsSync(shim)) continue
    // npm global layout: <prefix>/node_modules on Windows; elsewhere the shim
    // links to <package>/bin/index.js.
    const packageDir = windows
      ? join(dir, 'node_modules', '@evenrealities', 'evenhub-simulator')
      : dirname(dirname(realpathSync(shim)))
    try {
      const manifest = join(packageDir, 'package.json')
      const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
      const binary = windows ? 'evenhub-simulator.exe' : 'evenhub-simulator'
      const command = createRequire(manifest).resolve(
        `@evenrealities/sim-${process.platform}-${process.arch}/bin/${binary}`,
      )
      return { command, shell: false, version }
    } catch {
      return { command: shim, shell: windows, version: 'unknown' }
    }
  }
  throw new Error(
    'evenhub-simulator is not on PATH: npm install -g @evenrealities/evenhub-simulator, or set EVENHUB_SIMULATOR',
  )
}

export class Simulator {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`
    /** Every console entry seen so far: { id, level, message, ts }. */
    this.entries = []
    this.lastId = undefined
  }

  async #get(path, timeoutMs = 3000) {
    const response = await fetch(`${this.base}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`)
    return response
  }

  async ping() {
    const response = await this.#get('/api/ping', 1000)
    return (await response.text()).includes('pong')
  }

  async screenshot() {
    const response = await this.#get('/api/screenshot/glasses', 5000)
    return Buffer.from(await response.arrayBuffer())
  }

  async input(action) {
    const response = await fetch(`${this.base}/api/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      throw new Error(
        `input ${action}: HTTP ${response.status} ${await response.text()}`,
      )
    }
  }

  /** Reads console entries newer than the last one seen (since_id is exclusive). */
  async pollConsole() {
    const query = this.lastId === undefined ? '' : `?since_id=${this.lastId}`
    const { entries } = await (await this.#get(`/api/console${query}`)).json()
    const fresh = entries
      .filter((entry) => this.lastId === undefined || entry.id > this.lastId)
      .sort((a, b) => a.id - b.id)
    this.entries.push(...fresh)
    if (fresh.length > 0) this.lastId = fresh[fresh.length - 1].id
    return fresh
  }

  /** First console entry at or after index `from` whose message matches. */
  find(pattern, from = 0) {
    return this.entries.slice(from).find((entry) => pattern.test(entry.message))
  }
}
