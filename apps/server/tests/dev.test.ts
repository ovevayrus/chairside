import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeCalendar } from '../src/calendar/fake.js'
import { openDatabase } from '../src/db/index.js'
import {
  DEV_CONNECTION_ID,
  isDevEnabled,
  mountDevRoutes,
  type DevEnv,
} from '../src/dev/routes.js'
import { PairingService } from '../src/devices/pairing.js'
import { createApp } from '../src/http/app.js'
import { createRuntime } from '../src/http/runtime.js'
import { loadShopConfig } from '../src/shop/config.js'
import { FakeTelegramAdapter } from '../src/telegram/fake.js'

const logger = pino({ level: 'silent' })
const SHOP = 'demo-test'
const NONCE = 'dev-nonce-0123456789abcdef'
// A Saturday afternoon well ahead, inside the demo shop's hours (Asia/Dubai).
const REQUESTED = 'Can I get a skin fade Saturday 5 Dec 2099 at 3pm?'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function setup() {
  const db = openDatabase(':memory:')
  const telegram = new FakeTelegramAdapter()
  const calendar = new FakeCalendar()
  const shop = loadShopConfig()
  const runtime = createRuntime({
    db,
    shopId: SHOP,
    shop,
    mode: 'test',
    debounceMs: 10,
    telegram,
    calendar,
  })
  const pairing = new PairingService({
    db,
    shopId: SHOP,
    pepper: 'dev-test-pepper-' + 'x'.repeat(16),
  })
  cleanup.push(() => {
    runtime.pipeline.close()
    db.close()
  })
  const deps = {
    db,
    shopId: SHOP,
    shop,
    business: true,
    telegram,
    calendar,
    pairing,
    hub: runtime.hub,
  }
  return { ...runtime, deps, pairing, telegram, calendar }
}

const ENDPOINTS = [
  ['GET', '/dev/info'],
  ['POST', '/dev/pair'],
  ['POST', '/dev/inject'],
  ['POST', '/dev/calendar/block'],
  ['POST', '/dev/calendar/event'],
  ['GET', '/dev/fakes'],
] as const

function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    ...(method === 'POST'
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }
      : {}),
  })
}

describe('/dev endpoints are dev-only', () => {
  it.each<[string, DevEnv]>([
    ['DEV_INJECT unset', { NODE_ENV: 'development' }],
    ['DEV_INJECT=0', { DEV_INJECT: '0', NODE_ENV: 'development' }],
    ['DEV_INJECT=true', { DEV_INJECT: 'true', NODE_ENV: 'development' }],
    ['production', { DEV_INJECT: '1', NODE_ENV: 'production' }],
    ['production without DEV_INJECT', { NODE_ENV: 'production' }],
  ])('every /dev endpoint answers 404 with %s', async (_name, env) => {
    const { deps } = setup()
    const app = createApp({ logger })
    expect(isDevEnabled(env)).toBe(false)
    expect(mountDevRoutes(app, deps, env)).toBe(false)
    for (const [method, path] of ENDPOINTS) {
      expect((await call(app, method, path)).status, `${method} ${path}`).toBe(
        404,
      )
    }
  })

  it('re-checks the environment on every request', async () => {
    const { deps } = setup()
    const app = createApp({ logger })
    const env: DevEnv = { DEV_INJECT: '1', NODE_ENV: 'development' }
    expect(mountDevRoutes(app, deps, env)).toBe(true)
    expect((await call(app, 'GET', '/dev/info')).status).toBe(200)
    env.NODE_ENV = 'production'
    for (const [method, path] of ENDPOINTS)
      expect((await call(app, method, path)).status).toBe(404)
    env.NODE_ENV = 'development'
    env.DEV_INJECT = '0'
    for (const [method, path] of ENDPOINTS)
      expect((await call(app, method, path)).status).toBe(404)
  })

  it('answers 404 for unknown /dev paths when enabled', async () => {
    const { deps } = setup()
    const app = createApp({ logger })
    mountDevRoutes(app, deps, { DEV_INJECT: '1' })
    expect((await call(app, 'GET', '/dev/nope')).status).toBe(404)
  })
})

describe('/dev endpoints in TEST MODE', () => {
  function enabled() {
    const context = setup()
    const app = createApp({ logger, hub: context.hub })
    mountDevRoutes(app, context.deps, {
      DEV_INJECT: '1',
      NODE_ENV: 'development',
    })
    return { ...context, app }
  }

  it('reports TEST MODE for the glasses before pairing', async () => {
    const { app } = enabled()
    const response = await call(app, 'GET', '/dev/info')
    expect(await response.json()).toEqual({
      mode: 'test',
      shopName: "David's Barbers",
    })
  })

  it('binds the newest pending pairing code, then the device collects its token once', async () => {
    const { app, pairing } = enabled()
    expect((await call(app, 'POST', '/dev/pair')).status).toBe(404)
    const { code } = pairing.start(NONCE)
    const response = await call(app, 'POST', '/dev/pair')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      paired: true,
      codeSuffix: code.slice(-2),
    })
    const status = pairing.status(NONCE)
    expect(status.status).toBe('paired')
    expect(status).toHaveProperty('deviceToken')
    expect(pairing.status(NONCE)).toEqual({ status: 'paired' })
    // A bound code cannot be bound again.
    expect((await call(app, 'POST', '/dev/pair', { code })).status).toBe(409)
  })

  it('injects a DM through the fake adapter: one card, nothing sent', async () => {
    const { app, store, telegram } = enabled()
    const response = await call(app, 'POST', '/dev/inject', {
      firstName: 'Anna',
      text: REQUESTED,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true })
    expect(JSON.stringify(body)).not.toContain('skin fade')
    await vi.waitFor(() => expect(store.pending()).toHaveLength(1))
    const card = store.card(store.pending()[0]!)
    expect(card.header).toBe('NEW REQUEST')
    expect(card.lines[0]).toBe('Anna · Skin fade')
    expect(card.actions[0]?.label).toBe('Book & reply')
    expect(store.connection().id).toBe(DEV_CONNECTION_ID)
    expect(telegram.calls).toEqual([])
    // A second DM from another customer reuses the connection.
    await call(app, 'POST', '/dev/inject', {
      firstName: 'Omar',
      text: REQUESTED,
    })
    await vi.waitFor(() => expect(store.pending()).toHaveLength(2))
  })

  it('puts a foreign block and a Chairside booking in the fake calendar and reports the fakes', async () => {
    const { app, calendar } = enabled()
    const start = '2099-12-05T13:00:00.000Z'
    expect(
      (
        await call(app, 'POST', '/dev/calendar/block', {
          startUtc: start,
          minutes: 30,
        })
      ).status,
    ).toBe(200)
    const busy = await calendar.freeBusy(start, '2099-12-05T14:00:00.000Z')
    expect(busy).toEqual({
      ok: true,
      busy: [{ startUtc: start, endUtc: '2099-12-05T13:30:00.000Z' }],
    })
    expect(
      (
        await call(app, 'POST', '/dev/calendar/event', {
          startUtc: '2099-12-05T10:00:00Z',
          minutes: 45,
          name: 'Sami',
          serviceId: 'haircut',
        })
      ).status,
    ).toBe(200)
    const fakes = (await (await call(app, 'GET', '/dev/fakes')).json()) as {
      telegram: { sends: number }
      calendar: { events: { summary: string; chairside: boolean }[] }
    }
    expect(fakes.telegram.sends).toBe(0)
    expect(fakes.calendar.events).toEqual([
      expect.objectContaining({
        summary: 'Chairside · Sami · Haircut',
        chairside: true,
      }),
      expect.objectContaining({ summary: 'Busy', chairside: false }),
    ])
  })

  it('rejects malformed requests', async () => {
    const { app } = enabled()
    expect(
      (await call(app, 'POST', '/dev/inject', { firstName: 'Anna' })).status,
    ).toBe(400)
    expect(
      (
        await call(app, 'POST', '/dev/calendar/block', {
          startUtc: 'tomorrow',
          minutes: 30,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(app, 'POST', '/dev/calendar/event', {
          startUtc: '2099-12-05T10:00:00Z',
          minutes: 45,
          name: 'Sami',
          serviceId: 'massage',
        })
      ).status,
    ).toBe(400)
    expect(
      (await call(app, 'POST', '/dev/pair', { code: 'lower1' })).status,
    ).toBe(400)
  })
})
