import fc from 'fast-check'
import { DateTime } from 'luxon'
import { expect, it } from 'vitest'
import { findOpenings } from '../src/slots/engine.js'

const minutesPerDay = 24 * 60
const scenario = fc.record({
  tz: fc.constantFrom('Asia/Dubai', 'Asia/Kathmandu'),
  durationMin: fc.integer({ min: 15, max: 90 }),
  bufferMin: fc.integer({ min: 0, max: 15 }),
  gridMin: fc.constantFrom(5, 10, 15, 30),
  fromMin: fc.integer({ min: 0, max: minutesPerDay - 1 }),
  fromSecond: fc.constantFrom(0, 30),
  requestedMin: fc.option(fc.integer({ min: 0, max: minutesPerDay - 1 })),
  count: fc.integer({ min: 0, max: 12 }),
  busy: fc.array(
    fc.record({
      start: fc.integer({ min: -120, max: 2 * minutesPerDay }),
      length: fc.integer({ min: 1, max: 180 }),
    }),
    { maxLength: 20 },
  ),
})

it('returns the sorted, count-limited selection of grid starts inside hours and clear of buffered busy time', () => {
  fc.assert(
    fc.property(scenario, (s) => {
      const midnight = DateTime.fromISO('2026-12-07T00:00', { zone: s.tz })
      const instant = (minute: number) => midnight.toMillis() + minute * 60_000
      const iso = (minute: number) => new Date(instant(minute)).toISOString()
      const from = s.fromMin + s.fromSecond / 60
      const requested = s.requestedMin
      const result = findOpenings({
        hours: {
          1: { open: '08:07', close: '19:53' },
          2: { open: '10:10', close: '18:00' },
        },
        tz: s.tz,
        durationMin: s.durationMin,
        bufferMin: s.bufferMin,
        gridMin: s.gridMin,
        from: iso(from),
        requested: requested === null ? undefined : iso(requested),
        count: s.count,
        horizonDays: 2,
        busy: s.busy.map(({ start, length }) => ({
          startUtc: iso(start),
          endUtc: iso(start + length),
        })),
      })

      // Exhaustively check the two local days using integer minutes from Monday midnight.
      const fits: number[] = []
      const hoursInMinutes = [
        [8 * 60 + 7, 19 * 60 + 53],
        [10 * 60 + 10, 18 * 60],
      ] as const
      for (const [day, [open, close]] of hoursInMinutes.entries()) {
        for (let minute = open; minute + s.durationMin <= close; minute++) {
          const start = day * minutesPerDay + minute
          if (minute % s.gridMin !== 0 || start < from) continue
          const overlaps = s.busy.some(
            (b) =>
              start < b.start + b.length + s.bufferMin &&
              start + s.durationMin > b.start - s.bufferMin,
          )
          if (!overlaps) fits.push(start)
        }
      }

      expect(result.requestedFits).toBe(
        requested !== null && fits.includes(requested),
      )
      const preferred =
        requested === null
          ? fits
          : [
              ...fits.filter((t) => t > requested),
              ...fits.filter((t) => t < requested),
            ]
      const selected = preferred.slice(0, s.count).sort((a, b) => a - b)
      expect(
        result.openings.map(({ startUtc, endUtc }) => [
          Date.parse(startUtc),
          Date.parse(endUtc),
        ]),
      ).toEqual(selected.map((t) => [instant(t), instant(t + s.durationMin)]))
    }),
  )
})
