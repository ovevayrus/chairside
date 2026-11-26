import { randomUUID } from 'node:crypto'
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActionResponseSchema,
  type ActionRequest,
  type Card,
} from '@chairside/shared'
import { pino } from 'pino'
import { onTestFinished, vi } from 'vitest'
import { FakeCalendar } from '../src/calendar/fake.js'
import { openDatabase } from '../src/db/index.js'
import { createApp } from '../src/http/app.js'
import { createRuntime, type RuntimeOptions } from '../src/http/runtime.js'
import { createDevAuthenticator } from '../src/live/auth.js'
import { loadShopConfig } from '../src/shop/config.js'
import { FakeTelegramAdapter } from '../src/telegram/fake.js'

export const customerId = 55001
export const tenant = 'karim'
export const connectionId = 'fixture-business'
export const requestText = 'Skin fade on Saturday 5 Dec at 3pm'
export const expectedSlot = {
  startUtc: '2026-12-05T11:00:00.000Z',
  endUtc: '2026-12-05T11:45:00.000Z',
}

export function tap(card: Card, label = 'Book & reply'): ActionRequest {
  const action = card.actions.find((a) => a.label === label)
  if (!action) throw new Error(`Card does not offer ${label}`)
  return {
    requestId: card.requestId,
    version: card.version,
    actionId: action.id,
    idempotencyKey: randomUUID(),
  }
}

export async function bookingFixture(
  options: {
    persistent?: boolean
    checkpoint?: RuntimeOptions['checkpoint']
    callbacksSupported?: boolean
    debounceMs?: number
  } = {},
) {
  let time = Date.parse('2026-12-03T08:00:00.000Z')
  let sequence = 10
  const shop = loadShopConfig()
  const calendar = new FakeCalendar()
  const telegram = new FakeTelegramAdapter()
  const dir = options.persistent
    ? mkdtempSync(join(tmpdir(), 'chairside-booking-'))
    : undefined
  const path = dir ? join(dir, 'test.sqlite') : ':memory:'
  let db = openDatabase(path)
  const start = (checkpoint?: RuntimeOptions['checkpoint']) =>
    createRuntime({
      shopId: tenant,
      shop,
      db,
      telegram,
      calendar,
      mode: 'test',
      debounceMs: options.debounceMs ?? 0,
      now: () => new Date(time),
      callbacksSupported: options.callbacksSupported,
      checkpoint,
    })
  let runtime = start(options.checkpoint)
  await runtime.ready
  onTestFinished(() => {
    runtime.pipeline.close()
    db.close()
    if (dir) {
      for (const file of [path, path + '-wal', path + '-shm']) {
        if (existsSync(file)) unlinkSync(file)
      }
      rmdirSync(dir)
    }
  })
  await telegram.emit({
    type: 'connection',
    updateId: sequence++,
    connectionId,
    ownerUserId: 1,
    ownerChatId: 1,
    isEnabled: true,
    rights: {
      canReply: true,
      canReadMessages: true,
      canDeleteSentMessages: true,
      canDeleteAllMessages: false,
    },
  })

  async function receive(
    text: string,
    chatId = customerId,
    firstName = 'Anna',
  ) {
    const updateId = sequence++
    await telegram.emit({
      type: 'message',
      updateId,
      connectionId,
      chatId,
      messageId: updateId,
      fromId: chatId,
      firstName,
      text,
      dateIso: new Date(time).toISOString(),
      direction: 'incoming',
    })
    return updateId
  }
  return {
    calendar,
    telegram,
    shop,
    receive,
    get db() {
      return db
    },
    get runtime() {
      return runtime
    },
    advance(ms: number) {
      time += ms
    },
    now() {
      return new Date(time)
    },
    async restart() {
      if (!dir) throw new Error('Restart requires a file-backed fixture')
      runtime.pipeline.close()
      db.close()
      db = openDatabase(path)
      runtime = start()
      await runtime.ready
    },
    async cardFor(text = requestText, chatId = customerId, firstName = 'Anna') {
      const messageId = await receive(text, chatId, firstName)
      return vi.waitFor(
        () => {
          const row = runtime.store.forMessage(connectionId, chatId, messageId)
          if (!row || row.status !== 'pending')
            throw new Error('Card has not arrived')
          return runtime.store.card(row)
        },
        { interval: 5 },
      )
    },
    sends() {
      return telegram.calls.filter(
        (c) => c.method === 'sendText' || c.method === 'sendWithButton',
      )
    },
    bookings() {
      return db.prepare('SELECT * FROM bookings ORDER BY rowid').all()
    },
    events() {
      return calendar.listEvents('2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z')
    },
    post(body: unknown, bearer = 'device'.repeat(4)) {
      const app = createApp({
        logger: pino({ level: 'silent' }),
        hub: runtime.hub,
        authenticate: createDevAuthenticator(tenant, true),
        execute: (shopId, input) => {
          if (shopId !== tenant) throw new Error('Unexpected shop')
          return runtime.execute(input)
        },
      })
      return app.request('/api/actions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
      })
    },
    async postAction(input: ActionRequest) {
      const response = await this.post(input)
      return {
        http: response.status,
        body: ActionResponseSchema.parse(await response.json()),
      }
    },
  }
}
