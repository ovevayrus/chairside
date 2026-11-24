import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { FakeCalendar } from '../src/calendar/fake.js'
import {
  DEMO_MARKER,
  blockSlot,
  demoSummary,
  resetDemo,
  seedDemoEvents,
} from '../src/demo/index.js'
import { loadShopConfig } from '../src/shop/config.js'

const shop = loadShopConfig()
const now = DateTime.fromISO('2026-11-24T09:00:00', { zone: shop.timezone })
const local = (utc: string) =>
  DateTime.fromISO(utc, { zone: 'utc' })
    .setZone(shop.timezone)
    .toFormat('HH:mm')

describe('demo seed', () => {
  it('creates Sami 14:00 Haircut and Yusuf 16:15 Beard trim with markers', async () => {
    const cal = new FakeCalendar()
    const results = await seedDemoEvents(cal, shop, now, 'n1')
    expect(results.map((r) => r.status)).toEqual(['created', 'created'])
    const [sami, yusuf] = results.map((r) => r.event)
    expect(sami?.summary).toBe('Chairside · Sami · Haircut')
    expect(yusuf?.summary).toBe(demoSummary('Yusuf', 'Beard trim'))
    expect([local(sami!.startUtc), local(sami!.endUtc)]).toEqual([
      '14:00',
      '14:45',
    ])
    expect([local(yusuf!.startUtc), local(yusuf!.endUtc)]).toEqual([
      '16:15',
      '16:35',
    ])
    for (const e of [sami!, yusuf!]) {
      expect(e.privateProps[DEMO_MARKER]).toBe('1')
      expect(e.privateProps.chairsideBookingId).toBe(e.id)
    }
  })

  it('seed, reset, seed again works because ids are never reused', async () => {
    const cal = new FakeCalendar()
    await seedDemoEvents(cal, shop, now, 'a')
    await resetDemo(cal, shop, now)
    const again = await seedDemoEvents(cal, shop, now, 'b')
    expect(again.map((r) => r.status)).toEqual(['created', 'created'])
  })
})

describe('demo block', () => {
  it('inserts a foreign Busy block at the local time without a booking marker', async () => {
    const cal = new FakeCalendar()
    const event = await blockSlot(cal, shop, '2026-12-05 17:00', 30, 'n1')
    expect(event.summary).toBe('Busy')
    expect(event.startUtc).toBe('2026-12-05T13:00:00.000Z')
    expect(event.endUtc).toBe('2026-12-05T13:30:00.000Z')
    expect(event.privateProps).toEqual({ [DEMO_MARKER]: '1' })
    expect(event.privateProps.chairsideBookingId).toBeUndefined()
  })

  it('rejects bad input', async () => {
    const cal = new FakeCalendar()
    await expect(
      blockSlot(cal, shop, 'tomorrow 5pm', 30, 'n'),
    ).rejects.toThrow()
    await expect(
      blockSlot(cal, shop, '2026-12-05 17:00', 0, 'n'),
    ).rejects.toThrow()
  })
})

describe('demo reset', () => {
  it('removes only demo events in the window and leaves others alone', async () => {
    const cal = new FakeCalendar()
    await seedDemoEvents(cal, shop, now, 'n1')
    const block = await blockSlot(cal, shop, '2026-12-05 17:00', 30, 'n1')
    cal.addForeignEvent({
      id: 'foreign1',
      startUtc: '2026-11-24T08:00:00Z',
      endUtc: '2026-11-24T09:00:00Z',
    })
    cal.addForeignEvent({
      id: 'booking1',
      startUtc: '2026-11-25T08:00:00Z',
      endUtc: '2026-11-25T08:45:00Z',
      summary: 'Chairside · Anna · Skin fade',
      privateProps: { chairsideBookingId: 'booking1' },
    })
    cal.addForeignEvent({
      id: 'later1',
      startUtc: '2026-12-20T08:00:00Z',
      endUtc: '2026-12-20T09:00:00Z',
      privateProps: { [DEMO_MARKER]: '1' },
    })
    const removed = await resetDemo(cal, shop, now)
    expect(removed).toHaveLength(3)
    expect(removed.map((e) => e.id)).toContain(block.id)
    const left = await cal.listEvents(
      '2026-11-01T00:00:00Z',
      '2027-01-01T00:00:00Z',
    )
    expect(left.map((e) => e.id).sort()).toEqual([
      'booking1',
      'foreign1',
      'later1',
    ])
  })
})
