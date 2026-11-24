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
import { FakeTelegramAdapter } from '../src/telegram/fake.js'

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
