import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { serve } from '@hono/node-server'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { openDatabase } from '../src/db/index.js'
import { createPairCommandHandler } from '../src/devices/command.js'
import {
  CODE_ALPHABET,
  PairingService,
  hashToken,
} from '../src/devices/pairing.js'
import { createApp } from '../src/http/app.js'
import { attachLive, CLOSE_UNAUTHORIZED } from '../src/http/live.js'
import { createDeviceAuthenticator } from '../src/live/auth.js'
import type { ChatMessageEvent } from '../src/telegram/events.js'
import { FakeTelegramAdapter } from '../src/telegram/fake.js'

const OWNER = 801234567
const STRANGER = 999
const NONCE = 'nonce-0123456789abcdef'
const PEPPER = 'test-pepper-' + 'p'.repeat(20)
const logger = pino({ level: 'silent' })

let directory: string
let db: DatabaseSync
let clock: number
const now = () => new Date(clock)

beforeEach(() => {
  clock = Date.parse('2026-12-05T06:00:00Z')
  directory = mkdtempSync(join(tmpdir(), 'chairside-pair-'))
  db = openDatabase(join(directory, 'shop.sqlite'))
  db.prepare(
    `INSERT INTO shops (id, name, timezone, config_json, mode, updated_at)
     VALUES ('shop-1', 'Shop', 'UTC', '{}', 'test', ?)`,
  ).run(now().toISOString())
})

afterEach(() => {
  if (db.isOpen) db.close()
  rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const pairing = new PairingService({
    db,
    shopId: 'shop-1',
    pepper: PEPPER,
    now,
  })
  const telegram = new FakeTelegramAdapter()
  telegram.onEvent(
    createPairCommandHandler({
      pairing,
      telegram,
      isOwner: (id) => id === OWNER,
      now,
    }),
  )
  const say = (fromId: number, text: string, chatId = fromId) => {
    const event: ChatMessageEvent = {
      type: 'message',
      updateId: 1,
      chatId,
      messageId: 1,
      fromId,
      firstName: 'Karim',
      text,
      dateIso: now().toISOString(),
      direction: 'incoming',
    }
    return telegram.emit(event)
  }
  return { pairing, telegram, say }
}

describe('pairing flow', () => {
  it('shows a code, binds it on the owner /pair and returns the token exactly once', async () => {
    const { pairing, telegram, say } = setup()
    const { code, expiresAt } = pairing.start(NONCE)
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true)
    expect(Date.parse(expiresAt) - clock).toBe(10 * 60_000)
    expect(pairing.status(NONCE)).toEqual({ status: 'pending' })

    await say(OWNER, `/pair ${code.toLowerCase()}`)
    expect(telegram.calls).toHaveLength(1)
    expect(telegram.calls[0]).toMatchObject({ method: 'sendText' })

    const first = pairing.status(NONCE)
    expect(first.status).toBe('paired')
    const token = first.status === 'paired' ? first.deviceToken : undefined
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pairing.status(NONCE)).toEqual({ status: 'paired' })
    expect(pairing.authenticate(token!)).toBe('shop-1')
  })

  it('rejects an expired code', async () => {
    const { pairing, telegram, say } = setup()
    const { code } = pairing.start(NONCE)
    clock += 10 * 60_000 + 1
    await say(OWNER, `/pair ${code}`)
    expect(pairing.status(NONCE)).toEqual({ status: 'expired' })
    expect(telegram.calls).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toMatchObject(
      { n: 0 },
    )
  })

  it('rejects a reused code', async () => {
    const { pairing, say } = setup()
    const { code } = pairing.start(NONCE)
    expect(pairing.bind(code)).toBe(true)
    expect(pairing.bind(code)).toBe(false)
    await say(OWNER, `/pair ${code}`)
    pairing.status(NONCE)
    expect(pairing.bind(code)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toMatchObject(
      { n: 1 },
    )
  })

  it('rejects /pair from a non-owner and does not answer them', async () => {
    const { pairing, telegram, say } = setup()
    const { code } = pairing.start(NONCE)
    await say(STRANGER, `/pair ${code}`)
    expect(telegram.calls).toHaveLength(0)
    expect(pairing.status(NONCE)).toEqual({ status: 'pending' })
  })

  it('tells the owner a wrong code failed', async () => {
    const { pairing, telegram, say } = setup()
    pairing.start(NONCE)
    await say(OWNER, '/pair ZZZZZZ')
    expect(telegram.calls).toHaveLength(1)
    expect(pairing.status(NONCE)).toEqual({ status: 'pending' })
  })

  it('limits /pair to 5 attempts per minute per chat', async () => {
    const { pairing, telegram, say } = setup()
    const { code } = pairing.start(NONCE)
    for (let i = 0; i < 5; i++) await say(OWNER, '/pair AAAAAA')
    expect(telegram.calls).toHaveLength(5)
    // The sixth attempt is ignored even with the right code.
    await say(OWNER, `/pair ${code}`)
    expect(telegram.calls).toHaveLength(5)
    expect(pairing.status(NONCE)).toEqual({ status: 'pending' })
    clock += 61_000
    await say(OWNER, `/pair ${code}`)
    expect(pairing.status(NONCE).status).toBe('paired')
  })

  it('stores only sha256(pepper|token), never the token', () => {
    const { pairing } = setup()
    pairing.start(NONCE)
    pairing.bind(
      (db.prepare('SELECT code FROM pair_codes').get() as { code: string })
        .code,
    )
    const result = pairing.status(NONCE)
    const token = result.status === 'paired' ? result.deviceToken! : ''
    expect(token).not.toBe('')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const row = db.prepare('SELECT token_hash FROM devices').get() as {
      token_hash: string
    }
    expect(row.token_hash).toBe(hashToken(PEPPER, token))
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[]) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())
      expect(dump).not.toContain(token)
    }
    db.close()
    for (const file of readdirSync(directory))
      expect(readFileSync(join(directory, file)).includes(token)).toBe(false)
  })
})

describe('device authentication', () => {
  let server: Server | undefined
  afterEach(async () => {
    const current = server
    server = undefined
    if (!current) return
    current.closeAllConnections()
    await new Promise((resolve) => current.close(resolve))
  })

  async function boot() {
    const { pairing } = setup()
    const authenticate = createDeviceAuthenticator(pairing)
    const app = createApp({ logger, authenticate, pairing })
    const httpServer = serve({ fetch: app.fetch, port: 0 })
    if (!(httpServer instanceof Server)) throw new Error('expected HTTP/1.1')
    server = httpServer
    attachLive(httpServer, { logger, authenticate, helloTimeoutMs: 500 })
    await once(httpServer, 'listening')
    const { port } = httpServer.address() as AddressInfo
    return { pairing, app, port }
  }

  it('answers a wrong token with REST 401 and WS close 4401', async () => {
    const { app, port } = await boot()
    const bad = 'wrong-token-' + 'x'.repeat(30)
    const rest = await app.request('/api/actions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bad}` },
      body: '{}',
    })
    expect(rest.status).toBe(401)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', token: bad, appVersion: '1' }))
    const [code] = (await once(socket, 'close')) as [number]
    expect(code).toBe(CLOSE_UNAUTHORIZED)
  })

  it('accepts the paired token over WS and REST, and serves the pair routes', async () => {
    const { app, port } = await boot()
    const start = await app.request('/api/pair/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceNonce: NONCE }),
    })
    const { code } = (await start.json()) as { code: string }
    const pending = await app.request(`/api/pair/status?nonce=${NONCE}`)
    expect(await pending.json()).toEqual({ status: 'pending' })
    expect(
      (await app.request('/api/pair/start', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(400)

    db.prepare('UPDATE pair_codes SET shop_id=? WHERE code=?').run(
      'shop-1',
      code,
    )
    const paired = (await (
      await app.request(`/api/pair/status?nonce=${NONCE}`)
    ).json()) as { status: string; deviceToken: string }
    expect(paired.status).toBe('paired')
    const again = await (
      await app.request(`/api/pair/status?nonce=${NONCE}`)
    ).json()
    expect(again).toEqual({ status: 'paired' })

    const rest = await app.request('/api/actions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paired.deviceToken}` },
      body: '{}',
    })
    expect(rest.status).not.toBe(401)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await once(socket, 'open')
    socket.send(
      JSON.stringify({
        type: 'hello',
        token: paired.deviceToken,
        appVersion: '1',
      }),
    )
    const [data] = (await once(socket, 'message')) as [Buffer]
    expect(JSON.parse(data.toString())).toEqual({ type: 'hello.ok' })
    socket.close()
  })

  it('does not accept arbitrary well-formed tokens without the dev bypass', () => {
    const { pairing } = setup()
    const token = 'd'.repeat(24)
    expect(createDeviceAuthenticator(pairing)(token)).toBeNull()
    expect(createDeviceAuthenticator(pairing, 'shop-1')(token)).toBe('shop-1')
  })
})
