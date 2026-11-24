// Live spike S2: run with `npx tsx scripts/spike-calendar.ts` using real Google credentials.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DateTime } from 'luxon'
import { eventIdFor } from '../apps/server/src/calendar/eventId.js'
import { GoogleCalendarAdapter } from '../apps/server/src/calendar/google.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, 'apps/server/.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
const calendarId = process.env.GOOGLE_CALENDAR_ID
if (!jsonPath || !calendarId) {
  console.error(
    'Set GOOGLE_SERVICE_ACCOUNT_JSON_PATH (relative to apps/server) and GOOGLE_CALENDAR_ID in apps/server/.env or the environment.',
  )
  process.exit(1)
}

const adapter = new GoogleCalendarAdapter({
  serviceAccountJsonPath: jsonPath,
  calendarId,
})

const start = DateTime.now()
  .setZone('Asia/Dubai')
  .plus({ days: 2 })
  .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
const startUtc = start.toUTC().toISO()!
const endUtc = start.plus({ minutes: 45 }).toUTC().toISO()!
const requestId = `spike-${Date.now()}`
const id = eventIdFor('spike', requestId, startUtc)
const input = {
  id,
  startUtc,
  endUtc,
  summary: 'Chairside spike S2',
  privateProps: { chairsideBookingId: id, requestId },
}

const results: Array<{ name: string; pass: boolean; detail?: string }> = []
async function check(name: string, run: () => Promise<boolean | string>) {
  try {
    const out = await run()
    results.push({
      name,
      pass: out === true || typeof out === 'string',
      detail: typeof out === 'string' ? out : undefined,
    })
  } catch (error) {
    results.push({
      name,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

await check('freeBusy ok', async () => {
  const r = await adapter.freeBusy(startUtc, endUtc)
  return r.ok ? `busy intervals: ${r.busy.length}` : false
})
await check('insert with deterministic id', async () => {
  const r = await adapter.insertEvent(input)
  return r.status === 'created'
})
await check('same insert again returns already_ours', async () => {
  const r = await adapter.insertEvent(input)
  return r.status === 'already_ours'
})
await check('delete ok', async () => {
  await adapter.deleteEvent(id)
  return (await adapter.getEvent(id)) === null
})

const allPass = results.every((r) => r.pass)
const lines = [
  '',
  `### S2 Calendar (live run) ${DateTime.now().toUTC().toISODate()}`,
  '',
  `Run at ${new Date().toISOString()}. Result: ${allPass ? 'PASS' : 'FAIL'}.`,
  `Event id: ${id}`,
  `Slot: ${startUtc} to ${endUtc}`,
  '',
  ...results.map(
    (r) =>
      `- ${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`,
  ),
  '',
]
const spikes = resolve(root, 'docs/SPIKES.md')
mkdirSync(dirname(spikes), { recursive: true })
if (!existsSync(spikes)) writeFileSync(spikes, '# Spikes\n')
appendFileSync(spikes, lines.join('\n'))
console.log(lines.join('\n'))
process.exit(allPass ? 0 : 1)
