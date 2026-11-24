import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CalendarAdapter } from '../../apps/server/src/calendar/adapter.js'
import { GoogleCalendarAdapter } from '../../apps/server/src/calendar/google.js'
import {
  loadShopConfig,
  type ShopConfig,
} from '../../apps/server/src/shop/config.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface DemoContext {
  calendar: CalendarAdapter
  shop: ShopConfig
}

/** Loads apps/server/.env when present and builds the Google adapter, or exits 1 naming what is missing. */
export function demoContext(): DemoContext {
  const envPath = resolve(root, 'apps/server/.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  const calendarId = process.env.GOOGLE_CALENDAR_ID
  const missing: string[] = []
  if (!jsonPath) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON_PATH')
  if (!calendarId) missing.push('GOOGLE_CALENDAR_ID')
  if (!jsonPath || !calendarId) {
    console.error(
      `Missing ${missing.join(' and ')}. Set it in apps/server/.env or the environment.`,
    )
    process.exit(1)
  }
  const calendar = new GoogleCalendarAdapter({
    serviceAccountJsonPath: jsonPath,
    calendarId,
  })
  return { calendar, shop: loadShopConfig() }
}

/** Runs a script body; prints only the error message and exits 1 on failure. */
export async function runScript(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
