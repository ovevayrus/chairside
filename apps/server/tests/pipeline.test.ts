import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { ServerMessageSchema, type ServerMessage } from '@chairside/shared'
import type { Update } from 'grammy/types'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { FakeCalendar } from '../src/calendar/fake.js'
import { openDatabase } from '../src/db/index.js'
import { attachLive } from '../src/http/live.js'
import { createRuntime } from '../src/http/runtime.js'
import { createDevAuthenticator } from '../src/live/auth.js'
import { loadShopConfig } from '../src/shop/config.js'
import {
  toTelegramEvent,
  type ChatMessageEvent,
  type ConnectionEvent,
} from '../src/telegram/events.js'
import { FakeTelegramAdapter, textSha256 } from '../src/telegram/fake.js'
import { bookingFixture, customerId, tap } from './booking-fixture.js'

const owner = 801234567
function fixture(name: string) {
  const update: Update = JSON.parse(
    readFileSync(
      new URL(`./fixtures/telegram/${name}.json`, import.meta.url),
      'utf8',
    ),
  )
  const event = toTelegramEvent(update, owner)
  if (!event) throw new Error('Invalid fixture')
  return event
}
const message = fixture('business_message') as ChatMessageEvent
const connection = fixture('business_connection') as ConnectionEvent
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function setup(debounceMs: number | undefined = 10) {
  const db = openDatabase(':memory:')
  const telegram = new FakeTelegramAdapter()
  const calendar = new FakeCalendar()
  const runtime = createRuntime({
    db,
    shopId: 'karim',
    shop: loadShopConfig(),
    mode: 'test',
    ownerUserId: owner,
    now: () => new Date(message.dateIso),
    debounceMs,
    telegram,
    calendar,
  })
  cleanup.push(() => {
    runtime.pipeline.close()
    db.close()
  })
  return { ...runtime, telegram, calendar }
}

describe('inbound pipeline', () => {
  it('delivers one fixture card to an authenticated client within 3.5 seconds', async () => {
    const { telegram, hub } = setup(2_500)
    await telegram.emit(connection)
    const server = createServer()
    const sockets = attachLive(server, {
      logger: pino({ level: 'silent' }),
      hub,
      authenticate: createDevAuthenticator('karim', true),
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`,
    )
    cleanup.push(async () => {
      client.terminate()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const frames: ServerMessage[] = []
    client.on('message', (data) =>
      frames.push(ServerMessageSchema.parse(JSON.parse(data.toString()))),
    )
    await once(client, 'open')
    client.send(
      JSON.stringify({
        type: 'hello',
        token: 'device'.repeat(4),
        appVersion: 'test',
      }),
    )
    await vi.waitFor(() => expect(frames.at(-1)?.type).toBe('state'))
    const started = performance.now()
    await telegram.emit(message)
    await vi.waitFor(
      () =>
        expect(
          frames.some((f) => f.type === 'state' && f.root.pendingCount === 1),
        ).toBe(true),
      { timeout: 3_500, interval: 10 },
    )
    expect(performance.now() - started).toBeLessThan(3_500)
    const upserts = frames.filter((f) => f.type === 'card.upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.card).toMatchObject({
      header: 'NEW REQUEST',
      version: 1,
      lines: ['Anna · Skin fade', 'Sat 5 Dec · 15:00 · ● free (45 min)'],
    })
    expect(telegram.calls).toEqual([])
  })

  it('debounces three messages, ignores duplicates, versions an edit and removes a deleted source', async () => {
    const { telegram, hub, store } = setup()
    const frames = vi.spyOn(hub, 'broadcast')
    await telegram.emit(connection)
    for (const [index, text] of [
      'Can I book',
      'a skin fade',
      'Saturday 5 Dec at 3pm?',
    ].entries()) {
      await telegram.emit({
        ...message,
        text,
        messageId: message.messageId + index,
        updateId: 100 + index,
      })
    }
    await vi.waitFor(() => expect(store.pending()).toHaveLength(1))
    const [first] = store.pending()
    expect(store.card(first)).toMatchObject({
      version: 1,
      lines: ['Anna · Skin fade', 'Sat 5 Dec · 15:00 · ● free (45 min)'],
    })
    const edit = fixture('edited_business_message')
    await telegram.emit(edit)
    await telegram.emit(edit)
    await vi.waitFor(() => expect(store.get(first.id)?.version).toBe(2))
    expect(store.card(store.get(first.id)!).lines[1]).toContain('16:00')
    expect(
      frames.mock.calls.filter(([, f]) => f.type === 'card.upsert'),
    ).toHaveLength(2)
    const deleted = fixture('deleted_business_messages')
    if (deleted.type !== 'deleted') throw new Error('Invalid fixture')
    await telegram.emit({ ...deleted, updateId: 200, messageIds: [999] })
    expect(store.pending()).toHaveLength(1)
    await telegram.emit({ ...deleted, messageIds: [message.messageId + 1] })
    expect(store.pending()).toHaveLength(0)
    expect(frames).toHaveBeenCalledWith(store.shopId, {
      type: 'card.remove',
      requestId: first.id,
    })
  })

  it('removes a request handled by the owner and cancels its queued edit', async () => {
    const { telegram, store, hub } = setup()
    const frames = vi.spyOn(hub, 'broadcast')
    await telegram.emit(connection)
    await telegram.emit(message)
    await vi.waitFor(() => expect(store.pending()).toHaveLength(1))
    const [first] = store.pending()
    await telegram.emit(fixture('business_message_from_bot'))
    expect(store.get(first.id)?.status).toBe('pending')
    await telegram.emit(fixture('edited_business_message'))
    await telegram.emit(fixture('business_message_owner_reply'))
    await delay(30)
    expect(store.get(first.id)?.status).toBe('handled_elsewhere')
    expect(frames).toHaveBeenCalledWith(store.shopId, {
      type: 'card.remove',
      requestId: first.id,
    })
    expect(store.pending()).toHaveLength(0)
    expect(telegram.calls).toEqual([])
  })

  it.each(['disabled', 'missing can_reply'])(
    'offers no sending action when %s',
    async (condition) => {
      const { telegram, store } = setup()
      await telegram.emit({
        ...connection,
        isEnabled: condition !== 'disabled',
        rights: {
          ...connection.rights,
          canReply: condition !== 'missing can_reply',
        },
      })
      await telegram.emit(message)
      await vi.waitFor(() => expect(store.pending()).toHaveLength(1))
      const card = store.card(store.pending()[0])
      expect(card.header).toBe("CAN'T REPLY")
      expect(card.actions.map((a) => a.label)).toEqual(['Not now'])
      expect(telegram.calls).toEqual([])
    },
  )

  it('keeps foreign connections, plain commands and service updates off the owner display', async () => {
    const { telegram, store } = setup()
    await telegram.emit(connection)
    await telegram.emit({
      ...connection,
      updateId: 11,
      ownerUserId: owner + 1,
      connectionId: 'other',
    })
    await telegram.emit({ ...message, updateId: 12, connectionId: 'other' })
    await telegram.emit(fixture('message_owner_command'))
    await telegram.emit({ ...message, updateId: 13, text: '' })
    await delay(30)
    expect(store.pending()).toEqual([])
    expect(store.connection().id).toBe(connection.connectionId)
  })
})

describe('booking changes through the inbound pipeline', () => {
  it('shows the soonest booking by default and selects a booking on the named day', async () => {
    const f = await bookingFixture()
    for (const text of [
      'Beard trim Monday 7 Dec at 2pm',
      'Skin fade Saturday 5 Dec at 3pm',
    ]) {
      expect((await f.runtime.execute(tap(await f.cardFor(text)))).status).toBe(
        'ok',
      )
    }

    const soonest = await f.cardFor('can I come at 4 instead')
    expect(soonest).toMatchObject({
      header: 'WANTS TO MOVE',
      lines: ['Anna · Skin fade', 'Sat 5 Dec 15:00 ▶ 16:00 · ● free'],
    })
    const monday = await f.cardFor('Could we move Monday 7 Dec to 5pm?')
    expect(monday).toMatchObject({
      header: 'WANTS TO MOVE',
      lines: ['Anna · Beard trim', 'Mon 7 Dec 14:00 ▶ 17:00 · ● free'],
    })
    expect(monday.requestId).toBe(soonest.requestId)
    expect(f.sends()).toHaveLength(2)
    expect((await f.runtime.execute(tap(monday, 'Move & reply'))).status).toBe(
      'ok',
    )
    expect(await f.events()).toContainEqual(
      expect.objectContaining({
        startUtc: '2026-12-07T13:00:00.000Z',
        endUtc: '2026-12-07T13:20:00.000Z',
      }),
    )
    const cancel = await f.cardFor('Sorry, I need to cancel Monday 7 Dec')
    expect(cancel).toMatchObject({
      header: 'WANTS TO CANCEL',
      lines: ['Anna · Beard trim', 'Mon 7 Dec · 17:00'],
    })
    expect(cancel.actions.map((a) => a.label)).toEqual([
      'Cancel & reply',
      'Not now',
    ])
    expect(f.sends()).toHaveLength(3)
    expect(await f.events()).toHaveLength(2)
    expect(
      (await f.runtime.execute(tap(cancel, 'Cancel & reply'))).status,
    ).toBe('ok')
    expect(await f.events()).toEqual([
      expect.objectContaining({ startUtc: '2026-12-05T11:00:00.000Z' }),
    ])
  })

  it('keeps ordinary bookings separate from a prior booking in the same chat', async () => {
    const f = await bookingFixture()
    expect((await f.runtime.execute(tap(await f.cardFor()))).status).toBe('ok')
    const ordinary = await f.cardFor(
      'Can I get a haircut Saturday 23 Jan at 4pm?',
    )
    expect(ordinary).toMatchObject({
      header: 'NEW REQUEST',
      lines: ['Anna · Haircut', 'Sat 23 Jan · 16:00 · ● free (45 min)'],
    })
    const anotherChat = await f.cardFor(
      'can I come at 4 instead',
      customerId + 1,
      'Nina',
    )
    expect(anotherChat.header).toBe('NEW REQUEST')
    const cancel = await f.cardFor(
      'Sorry, I need to cancel',
      customerId + 1,
      'Nina',
    )
    expect(cancel).toMatchObject({ header: 'WANTS TO CANCEL', lines: ['Nina'] })
    expect(cancel.actions.map((a) => a.label)).toEqual(['Not now'])
    expect(f.sends()).toHaveLength(1)
  })

  it.each([
    ['Could I come 3-ish hours later?', 'Saturday 5 Dec'],
    ['Could I come 3-ish hours later on Friday 4 Dec?', 'Friday 4 Dec'],
  ])(
    'routes service changes to the owner and asks for a time for %j',
    async (text, day) => {
      const f = await bookingFixture()
      const booked = await f.cardFor('Haircut Saturday 5 Dec at 3pm')
      expect((await f.runtime.execute(tap(booked))).status).toBe('ok')

      const serviceChange = await f.cardFor(
        'Can I switch to a skin fade instead?',
      )
      expect(serviceChange.header).toBe('NEEDS YOU')
      expect(serviceChange.actions.map((action) => action.label)).toEqual([
        'Not now',
      ])

      const unclear = await f.cardFor(text)
      expect(unclear.header).toBe('WANTS TO MOVE')
      expect(unclear.actions.map((action) => action.label)).toEqual([
        'Ask what time suits',
        'Not now',
      ])
      expect(f.sends()).toHaveLength(1)
      const events = await f.events()
      const response = await f.runtime.execute(
        tap(unclear, 'Ask what time suits'),
      )
      expect(response.status).toBe('ok')
      expect(f.sends()).toHaveLength(2)
      expect(f.sends()[1]?.textSha256).toBe(
        textSha256(`Hi Anna! What time suits you for your Haircut on ${day}?`),
      )
      expect(await f.events()).toEqual(events)
    },
  )

  it.each(['unconfirmed', 'past', 'cancelled'])(
    'skips a booking that is %s',
    async (state) => {
      const f = await bookingFixture()
      const first = await f.cardFor()
      if (state === 'unconfirmed')
        f.telegram.failNext({ code: 400 }, 'sendText')
      expect((await f.runtime.execute(tap(first))).status).toBe(
        state === 'unconfirmed' ? 'send_failed' : 'ok',
      )
      if (state === 'past') f.advance(3 * 24 * 60 * 60_000)
      if (state === 'cancelled') {
        const cancel = await f.cardFor('Please cancel my appointment')
        expect(
          (await f.runtime.execute(tap(cancel, 'Cancel & reply'))).status,
        ).toBe('ok')
      }
      expect((await f.cardFor('can I come at 4 instead')).header).toBe(
        'NEW REQUEST',
      )
      const cancel = await f.cardFor('Please cancel my appointment')
      expect(cancel.actions.map((a) => a.label)).toEqual(['Not now'])
    },
  )

  it.each([
    'Can we move it to 11am?',
    'Can we move it to 7:30pm?',
    'Can we move it to 3:07pm?',
    'Can I reschedule to Sunday 2pm?',
  ])('never offers a move to an unavailable time in %j', async (text) => {
    const f = await bookingFixture()
    const booking = await f.cardFor('Skin fade Thursday 3 Dec at 3pm')
    expect((await f.runtime.execute(tap(booking))).status).toBe('ok')
    const card = await f.cardFor(text)
    expect(card.header).toBe('WANTS TO MOVE')
    expect(card.actions.map((a) => a.label)).not.toContain('Move & reply')
    expect(f.sends()).toHaveLength(1)
  })
})
