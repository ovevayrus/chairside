// Dev-only endpoints for the local TEST MODE and the simulator e2e. They drive
// the FAKE adapters only: inject a customer DM through the fake Telegram
// adapter, put a block or a booking in the fake calendar, bind the newest
// pairing code, and report what the fakes recorded (message hashes, never
// text). Mounted only when DEV_INJECT=1 and NODE_ENV is not "production", and
// every request re-checks that, so /dev/* answers 404 everywhere else.
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { FakeCalendar } from '../calendar/fake.js'
import type { PairingService } from '../devices/pairing.js'
import type { LiveHub } from '../live/hub.js'
import type { ShopConfig } from '../shop/config.js'
import type { FakeTelegramAdapter } from '../telegram/fake.js'

export interface DevEnv {
  DEV_INJECT?: string
  NODE_ENV?: string
}

/** The only switch: DEV_INJECT=1 on a server that is not in production. */
export function isDevEnabled(env: DevEnv): boolean {
  return env.DEV_INJECT === '1' && env.NODE_ENV !== 'production'
}

export interface DevDeps {
  db: DatabaseSync
  shopId: string
  shop: ShopConfig
  /** Business mode: DMs arrive through a (fake) business connection. */
  business: boolean
  /** OWNER_TELEGRAM_USER_ID when set; the fake connection then belongs to it. */
  ownerUserId?: number
  telegram: FakeTelegramAdapter
  calendar: FakeCalendar
  pairing: PairingService
  hub: LiveHub
}

export const DEV_CONNECTION_ID = 'dev-test-connection'
const DEV_OWNER_ID = 700_000_001
const SEND_METHODS = new Set(['sendText', 'sendWithButton'])
const EVERYTHING = ['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z'] as const

const InjectSchema = z.object({
  firstName: z.string().trim().min(1).max(64),
  text: z.string().min(1).max(1000),
  chatId: z.int().positive().optional(),
})
const PairSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Z0-9]{6}$/)
    .optional(),
})
const BlockSchema = z.object({
  startUtc: z.iso.datetime({ offset: true }),
  minutes: z.int().min(1).max(600),
})
const EventSchema = BlockSchema.extend({
  name: z.string().trim().min(1).max(24),
  serviceId: z.string().min(1),
})

/** A stable chat id per first name, so one name is one chat. */
function chatIdFor(firstName: string): number {
  const digest = createHash('sha256').update(firstName.toLowerCase()).digest()
  return 600_000_000 + (digest.readUInt32BE(0) % 99_000_000)
}

async function body(c: { req: { json(): Promise<unknown> } }) {
  return c.req.json().catch(() => null)
}

/**
 * Adds the /dev routes to `app` when the environment allows it; returns
 * whether it did. `env` defaults to process.env and is read on every request.
 */
export function mountDevRoutes(
  app: Hono,
  deps: DevDeps,
  env: DevEnv = process.env,
): boolean {
  if (!isDevEnabled(env)) return false
  const { db, shopId, shop, telegram, calendar, pairing, hub } = deps
  const ownerId = deps.ownerUserId ?? DEV_OWNER_ID
  // Telegram-like ids that never repeat, even across restarts on one database.
  let lastId = Date.now()
  const nextId = () => ++lastId
  let blocks = 0

  app.use('/dev/*', async (c, next) => {
    if (!isDevEnabled(env)) return c.notFound()
    c.header('Cache-Control', 'no-store')
    await next()
  })

  app.get('/dev/info', (c) => c.json({ mode: 'test', shopName: shop.name }))

  app.post('/dev/pair', async (c) => {
    const input = PairSchema.safeParse((await body(c)) ?? {})
    if (!input.success) return c.json({ error: 'invalid_request' }, 400)
    const code =
      input.data.code ??
      (
        db
          .prepare(
            `SELECT code FROM pair_codes WHERE shop_id IS NULL AND consumed_at IS NULL
           AND expires_at > ? ORDER BY rowid DESC LIMIT 1`,
          )
          .get(new Date().toISOString()) as { code: string } | undefined
      )?.code
    if (!code) return c.json({ error: 'no_pending_code' }, 404)
    if (!pairing.bind(code)) return c.json({ error: 'not_bound' }, 409)
    return c.json({ paired: true, codeSuffix: code.slice(-2) })
  })

  app.post('/dev/inject', async (c) => {
    const input = InjectSchema.safeParse(await body(c))
    if (!input.success) return c.json({ error: 'invalid_request' }, 400)
    const { firstName, text } = input.data
    const chatId = input.data.chatId ?? chatIdFor(firstName)
    if (deps.business) {
      const known = db
        .prepare('SELECT business_connection_id FROM shops WHERE id=?')
        .get(shopId) as { business_connection_id: string | null } | undefined
      if (known?.business_connection_id !== DEV_CONNECTION_ID) {
        await telegram.emit({
          type: 'connection',
          updateId: nextId(),
          connectionId: DEV_CONNECTION_ID,
          ownerUserId: ownerId,
          ownerChatId: ownerId,
          isEnabled: true,
          rights: {
            canReply: true,
            canReadMessages: true,
            canDeleteSentMessages: true,
            canDeleteAllMessages: false,
          },
        })
      }
    }
    const updateId = nextId()
    const messageId = nextId()
    // The text exists only in this call and the pipeline's debounce memory.
    await telegram.emit({
      type: 'message',
      updateId,
      connectionId: deps.business ? DEV_CONNECTION_ID : undefined,
      chatId,
      messageId,
      fromId: chatId,
      firstName,
      text,
      dateIso: new Date().toISOString(),
      direction: 'incoming',
    })
    return c.json({ ok: true, chatId, messageId, updateId })
  })

  app.post('/dev/calendar/block', async (c) => {
    const input = BlockSchema.safeParse(await body(c))
    if (!input.success) return c.json({ error: 'invalid_request' }, 400)
    const start = Date.parse(input.data.startUtc)
    // Someone else's event: no Chairside marker, so the executor sees a conflict.
    const event = calendar.addForeignEvent({
      id: `devblock${++blocks}x${Date.now().toString(32)}`,
      startUtc: new Date(start).toISOString(),
      endUtc: new Date(start + input.data.minutes * 60_000).toISOString(),
      summary: 'Busy',
    })
    return c.json({ ok: true, id: event.id })
  })

  app.post('/dev/calendar/event', async (c) => {
    const input = EventSchema.safeParse(await body(c))
    if (!input.success) return c.json({ error: 'invalid_request' }, 400)
    const service = shop.services.find((s) => s.id === input.data.serviceId)
    if (!service) return c.json({ error: 'unknown_service' }, 400)
    const start = Date.parse(input.data.startUtc)
    const id = `devbooking${nextId().toString(32)}`
    // An existing appointment, as Chairside would have written it.
    const result = await calendar.insertEvent({
      id,
      startUtc: new Date(start).toISOString(),
      endUtc: new Date(start + input.data.minutes * 60_000).toISOString(),
      summary: `Chairside · ${input.data.name} · ${service.name}`,
      privateProps: { chairsideBookingId: id, requestId: 'dev-seed' },
    })
    if (result.status === 'conflict') return c.json({ error: 'conflict' }, 409)
    await hub.broadcastState(shopId)
    return c.json({ ok: true, id })
  })

  app.get('/dev/fakes', async (c) => {
    const events = await calendar.listEvents(...EVERYTHING)
    return c.json({
      telegram: {
        sends: telegram.calls.filter((call) => SEND_METHODS.has(call.method))
          .length,
        calls: telegram.calls.map((call) => ({
          method: call.method,
          chatId: call.chatId,
          messageId: call.messageId,
          failed: call.failed,
        })),
      },
      calendar: {
        events: events.map((event) => ({
          id: event.id,
          startUtc: event.startUtc,
          endUtc: event.endUtc,
          summary: event.summary,
          chairside: Boolean(event.privateProps.chairsideBookingId),
        })),
      },
    })
  })

  return true
}
