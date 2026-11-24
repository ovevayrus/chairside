// The Chairside backend for simulator runs: always TEST MODE (DEV_INJECT=1,
// fake Telegram and fake calendar) on a fresh database in a temp folder, with
// real-service credentials removed from its environment. Also a small client
// for its dev-only endpoints (/dev/*).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpOk, ports, root, step } from './harness.mjs'
import { start, stop, waitFor } from './processes.mjs'

// Never handed to a TEST MODE backend: it must not even see real credentials.
const STRIPPED = [
  'TELEGRAM_BOT_TOKEN',
  'OWNER_TELEGRAM_USER_ID',
  'GOOGLE_CALENDAR_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON_PATH',
  'CALLBACKS_SUPPORTED',
  'PUBLIC_BASE_URL',
  'TELEGRAM_WEBHOOK_SECRET',
  'STT_BASE_URL',
  'STT_API_KEY',
  'LLM_BASE_URL',
  'LLM_API_KEY',
]

export class Backend {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'chairside-e2e-'))
    this.dbPath = join(this.dir, 'chairside-e2e.db')
    // Kept across a restart so a paired device token stays valid.
    this.pepper = randomBytes(32).toString('hex')
    this.base = `http://127.0.0.1:${ports.backend}`
    this.proc = undefined
  }

  env() {
    const env = { ...process.env }
    for (const name of STRIPPED) delete env[name]
    return {
      ...env,
      PORT: String(ports.backend),
      NODE_ENV: 'development',
      DEV_INJECT: '1',
      TELEGRAM_MODE: 'business',
      DATABASE_PATH: this.dbPath,
      DEVICE_TOKEN_PEPPER: this.pepper,
    }
  }

  async start() {
    step(`starting the backend (TEST MODE, fake adapters) on :${ports.backend}`)
    this.proc = start(
      'backend',
      process.execPath,
      ['--import', 'tsx', 'src/index.ts'],
      { cwd: join(root, 'apps', 'server'), env: this.env(), windowsHide: true },
    )
    await waitFor('the backend /healthz', 20_000, () =>
      httpOk(`${this.base}/healthz`),
    )
  }

  async stop() {
    if (this.proc) await stop(this.proc)
    this.proc = undefined
  }

  /** Stops the backend and deletes its temp database. */
  async dispose() {
    await this.stop()
    rmSync(this.dir, { recursive: true, force: true })
  }

  /** Calls a /dev endpoint; throws on a non-2xx answer. */
  async dev(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: HTTP ${response.status} ${JSON.stringify(json)}`,
      )
    }
    return json
  }

  /** What the fakes hold: Telegram sends (hashes only) and calendar events. */
  fakes() {
    return this.dev('GET', '/dev/fakes')
  }
}
