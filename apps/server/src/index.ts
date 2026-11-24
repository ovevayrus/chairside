import { Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { pino } from 'pino'
import { FakeCalendar, googleCalendarFromEnv } from './calendar/index.js'
import { openDatabase } from './db/index.js'
import { createApp } from './http/app.js'
import { attachLive } from './http/live.js'
import { createRuntime } from './http/runtime.js'
import { createDevAuthenticator } from './live/auth.js'
import { loadShopConfig } from './shop/config.js'
import { BusinessTelegramAdapter } from './telegram/business.js'
import { normalizeConnection } from './telegram/events.js'
import { FakeTelegramAdapter } from './telegram/fake.js'
import { ShopBotTelegramAdapter } from './telegram/shopbot.js'

const logger = pino()

const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `PORT must be an integer from 1 to 65535, got "${process.env.PORT}"`,
  )
}

const testMode = process.env.DEV_INJECT === '1'
const dev = process.env.NODE_ENV !== 'production'
if (testMode && !dev)
  throw new Error('DEV_INJECT requires a development server')
const shopId = testMode ? 'demo-test' : 'demo'
const authenticate = createDevAuthenticator(shopId, dev)

function startRuntime() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  // Preserve the original dev health/hello server when integrations are unconfigured.
  if (dev && !testMode && !token && !process.env.GOOGLE_CALENDAR_ID) return
  const ownerUserId = Number(process.env.OWNER_TELEGRAM_USER_ID)
  if (
    !testMode &&
    (!token || !Number.isSafeInteger(ownerUserId) || ownerUserId < 1)
  )
    throw new Error('Configure TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_USER_ID')
  const telegramMode = process.env.TELEGRAM_MODE ?? 'business'
  if (!['business', 'bot'].includes(telegramMode))
    throw new Error('Invalid TELEGRAM_MODE')
  const business = telegramMode === 'business'
  const calendar = testMode ? new FakeCalendar() : googleCalendarFromEnv()
  const Adapter = business ? BusinessTelegramAdapter : ShopBotTelegramAdapter
  const telegram = testMode
    ? new FakeTelegramAdapter()
    : new Adapter({ token: token!, ownerUserId })
  const shop = loadShopConfig(process.env.SHOP_CONFIG_PATH)
  const serverRoot = fileURLToPath(new URL('../', import.meta.url))
  const dbPath = resolve(
    serverRoot,
    process.env.DATABASE_PATH ||
      (testMode ? 'data/test.db' : 'data/chairside.db'),
  )
  mkdirSync(dirname(dbPath), { recursive: true })
  const runtime = createRuntime({
    db: openDatabase(dbPath),
    shopId,
    shop,
    mode: testMode ? 'test' : 'live',
    callbacksSupported: process.env.CALLBACKS_SUPPORTED === 'true',
    business,
    calendar,
    telegram,
    ownerUserId:
      Number.isSafeInteger(ownerUserId) && ownerUserId > 0
        ? ownerUserId
        : undefined,
    getConnection:
      telegram instanceof BusinessTelegramAdapter
        ? async (id) => normalizeConnection(await telegram.getConnection(id))
        : undefined,
  })
  return { ...runtime, telegram }
}

const runtime = startRuntime()
await runtime?.ready
const server = serve(
  {
    fetch: createApp({
      logger,
      hub: runtime?.hub,
      authenticate,
      execute:
        runtime &&
        ((id, input) => {
          if (id !== shopId) throw new Error('Shop mismatch')
          return runtime.execute(input)
        }),
    }).fetch,
    port,
  },
  (info) => {
    logger.info({ port: info.port }, 'chairside server listening')
  },
)
if (!(server instanceof Server)) throw new Error('Expected an HTTP/1.1 server')

attachLive(server, {
  logger,
  authenticate,
  hub: runtime?.hub,
})
if (runtime && !(runtime.telegram instanceof FakeTelegramAdapter)) {
  runtime.telegram.start().catch(() => {
    logger.error('Telegram polling stopped')
    process.exit(1)
  })
}
