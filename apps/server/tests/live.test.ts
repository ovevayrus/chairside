import { on, once } from 'node:events'
import { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ServerMessageSchema, type Card } from '@chairside/shared'
import { serve } from '@hono/node-server'
import { pino } from 'pino'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { FakeCalendar } from '../src/calendar/fake.js'
import { createApp } from '../src/http/app.js'
import { attachLive } from '../src/http/live.js'
import { createDevAuthenticator } from '../src/live/auth.js'
import { LiveHub } from '../src/live/hub.js'

const logger = pino({ level: 'silent' })
const now = () => new Date('2026-12-05T06:00:00Z')
const card: Card = {
  requestId: 'request-1',
  version: 1,
  header: 'NEW REQUEST',
  lines: ['Anna'],
  actions: [{ id: 'later', label: 'Not now' }],
  index: 1,
  total: 1,
}

it("polls the authenticated shop for pending cards and today's next two appointments", async () => {
  const calendar = new FakeCalendar()
  const shop = {
    name: 'Barbers',
    timezone: 'Asia/Dubai',
    mode: 'test' as const,
    calendar,
    pendingCards: () => [card],
  }
  const hub = new LiveHub(() => shop, now)
  const token = 'd'.repeat(16)
  const app = createApp({
    logger,
    hub,
    authenticate: createDevAuthenticator('demo', true),
  })
  calendar.addForeignEvent({
    startUtc: '2026-12-05T05:00Z',
    endUtc: '2026-12-05T05:45Z',
  })
  calendar.addForeignEvent({
    startUtc: '2026-12-05T06:30Z',
    endUtc: '2026-12-05T07:00Z',
    summary: 'Chairside · Private name · Private appointment',
  })
  await calendar.insertEvent({
    id: 'booking',
    startUtc: '2026-12-05T07:30Z',
    endUtc: '2026-12-05T08:15Z',
    summary: 'Chairside · Anna · Skin fade',
    privateProps: { chairsideBookingId: 'booking' },
  })
  const request = () =>
    app.request('/api/state?since=3', {
      headers: { Authorization: `Bearer ${token}` },
    })
  expect((await app.request('/api/state')).status).toBe(401)
  expect(
    (
      await app.request('/api/state', {
        headers: { Authorization: 'Bearer short' },
      })
    ).status,
  ).toBe(401)
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    type: 'state',
    seq: 1,
    cards: [card],
    root: {
      shopName: 'Barbers',
      mode: 'test',
      pendingCount: 1,
      now: now().toISOString(),
      next: { time: '10:30', name: 'Busy', service: '' },
      then: { time: '11:30', name: 'Anna', service: 'Skin fade' },
    },
  })
})

it('sends an initial state and preserves a removal during a slower calendar refresh', async () => {
  const calendar = new FakeCalendar()
  let cards = [card]
  const hub = new LiveHub(
    (shopId) => ({
      name: shopId,
      timezone: 'UTC',
      mode: 'test',
      calendar,
      pendingCards: () => cards,
    }),
    now,
  )
  const authenticate = createDevAuthenticator('demo', true)
  const server = serve({ fetch: createApp({ logger }).fetch, port: 0 })
  if (!(server instanceof Server)) throw new Error('expected HTTP/1.1')
  attachLive(server, { logger, hub, authenticate })
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const messages = on(socket, 'message')
  const read = async () => {
    const { value } = await messages.next()
    const [data] = value as [Buffer]
    return ServerMessageSchema.parse(JSON.parse(data.toString()))
  }
  try {
    await once(socket, 'open')
    socket.send(
      JSON.stringify({
        type: 'hello',
        token: 'd'.repeat(16),
        appVersion: 'test',
      }),
    )
    expect(await read()).toEqual({ type: 'hello.ok' })
    expect(await read()).toMatchObject({ type: 'state', seq: 1, cards: [card] })
    const started = Promise.withResolvers<void>()
    const events = Promise.withResolvers<[]>()
    vi.spyOn(calendar, 'listEvents').mockImplementationOnce(() => {
      started.resolve()
      return events.promise
    })
    const refresh = hub.broadcastState('demo')
    await started.promise
    cards = []
    hub.broadcast('elsewhere', { type: 'receipt', text: 'Private' })
    hub.broadcast('demo', { type: 'card.remove', requestId: card.requestId })
    expect(await read()).toEqual({
      type: 'card.remove',
      seq: 2,
      requestId: card.requestId,
    })
    events.resolve([])
    await refresh
    expect(await read()).toMatchObject({
      type: 'state',
      seq: 3,
      root: { pendingCount: 0 },
      cards: [],
    })
  } finally {
    await messages.return()
    socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
