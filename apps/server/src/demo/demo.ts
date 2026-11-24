import { DateTime } from 'luxon'
import type { CalEvent, CalendarAdapter } from '../calendar/adapter.js'
import { eventIdFor } from '../calendar/eventId.js'
import type { ShopConfig } from '../shop/config.js'

/** Private extended property that marks events created by the demo scripts. */
export const DEMO_MARKER = 'chairsideDemo'
const DEMO_SHOP_ID = 'demo'
const RESET_DAYS_AHEAD = 14

export interface DemoSeedEntry {
  name: string
  serviceId: string
  /** Local shop time, HH:mm. */
  time: string
}

export const DEMO_SEED: readonly DemoSeedEntry[] = [
  { name: 'Sami', serviceId: 'haircut', time: '14:00' },
  { name: 'Yusuf', serviceId: 'beard_trim', time: '16:15' },
]

export function demoSummary(name: string, service: string): string {
  return `Chairside · ${name} · ${service}`
}

export function isDemoEvent(event: CalEvent): boolean {
  return event.privateProps[DEMO_MARKER] === '1'
}

/** Parses "yyyy-MM-dd HH:mm" as local time in the shop's time zone. */
export function parseLocalTime(text: string, zone: string): DateTime {
  const parsed = DateTime.fromFormat(text.trim(), 'yyyy-MM-dd HH:mm', { zone })
  if (!parsed.isValid) {
    throw new Error(`Cannot read "${text}" as "yyyy-MM-dd HH:mm" (${zone})`)
  }
  return parsed
}

export interface SeedResult {
  event: CalEvent
  status: 'created' | 'already_ours'
}

/**
 * Creates today's demo bookings. `nonce` keeps ids unique per run, because
 * Google never lets a deleted event id be inserted again.
 */
export async function seedDemoEvents(
  calendar: CalendarAdapter,
  shop: ShopConfig,
  now: DateTime,
  nonce: string,
): Promise<SeedResult[]> {
  const day = now.setZone(shop.timezone).startOf('day')
  const results: SeedResult[] = []
  for (const entry of DEMO_SEED) {
    const service = shop.services.find(({ id }) => id === entry.serviceId)
    if (!service) throw new Error(`Unknown service ${entry.serviceId}`)
    const [hour, minute] = entry.time.split(':').map(Number)
    const start = day.set({ hour, minute })
    const startUtc = start.toUTC().toISO()!
    const endUtc = start.plus({ minutes: service.durationMin }).toUTC().toISO()!
    const id = eventIdFor(DEMO_SHOP_ID, `seed-${entry.name}-${nonce}`, startUtc)
    const result = await calendar.insertEvent({
      id,
      startUtc,
      endUtc,
      summary: demoSummary(entry.name, service.name),
      privateProps: { [DEMO_MARKER]: '1', chairsideBookingId: id },
    })
    if (result.status === 'conflict') {
      throw new Error(`Event id ${id} already exists in the calendar`)
    }
    results.push({ event: result.event, status: result.status })
  }
  return results
}

/**
 * Inserts a foreign block: demo marker (so reset removes it) but no
 * chairsideBookingId, so the executor treats it as another person's event.
 */
export async function blockSlot(
  calendar: CalendarAdapter,
  shop: ShopConfig,
  localTime: string,
  minutes: number,
  nonce: string,
): Promise<CalEvent> {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`Minutes must be a positive whole number, got ${minutes}`)
  }
  const start = parseLocalTime(localTime, shop.timezone)
  const startUtc = start.toUTC().toISO()!
  const endUtc = start.plus({ minutes }).toUTC().toISO()!
  const id = eventIdFor(DEMO_SHOP_ID, `block-${nonce}`, startUtc)
  const result = await calendar.insertEvent({
    id,
    startUtc,
    endUtc,
    summary: 'Busy',
    privateProps: { [DEMO_MARKER]: '1' },
  })
  if (result.status === 'conflict') {
    throw new Error(`Event id ${id} already exists in the calendar`)
  }
  return result.event
}

/** Deletes only events with chairsideDemo=1 from today to 14 days ahead. */
export async function resetDemo(
  calendar: CalendarAdapter,
  shop: ShopConfig,
  now: DateTime,
): Promise<CalEvent[]> {
  const from = now.setZone(shop.timezone).startOf('day')
  const to = from.plus({ days: RESET_DAYS_AHEAD + 1 })
  const events = await calendar.listEvents(
    from.toUTC().toISO()!,
    to.toUTC().toISO()!,
  )
  const removed: CalEvent[] = []
  for (const event of events.filter(isDemoEvent)) {
    await calendar.deleteEvent(event.id)
    removed.push(event)
  }
  return removed
}

export function formatLocal(event: CalEvent, zone: string): string {
  const fmt = (utc: string, pattern: string) =>
    DateTime.fromISO(utc, { zone: 'utc' }).setZone(zone).toFormat(pattern)
  return `${fmt(event.startUtc, 'yyyy-MM-dd HH:mm')}-${fmt(event.endUtc, 'HH:mm')}`
}
