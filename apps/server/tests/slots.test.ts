import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { findOpenings, type FindOpeningsInput } from '../src/slots/engine.js'

const saturday = '2026-12-05'
const monday = '2026-12-07'
const shopDay = { open: '10:00', close: '20:00' } as const
const shop: FindOpeningsInput = {
  hours: {
    1: shopDay,
    2: shopDay,
    3: shopDay,
    4: shopDay,
    5: shopDay,
    6: shopDay,
  },
  tz: 'Asia/Dubai',
  durationMin: 45,
  bufferMin: 5,
  gridMin: 15,
  busy: [],
  from: dubai(saturday, '10:00'),
}

function dubai(date: string, time: string) {
  return `${date}T${time}:00+04:00`
}

function startTimes({ openings }: ReturnType<typeof findOpenings>) {
  return openings.map(({ startUtc }) => Date.parse(startUtc))
}

describe('findOpenings', () => {
  it.each([
    ['skin fade', 45, '15:00', '15:45', '16:00'],
    ['beard trim', 20, '17:00', '17:30', '17:45'],
  ] as const)(
    'offers the next %s after a busy interval',
    (_service, durationMin, start, end, next) => {
      const requested = dubai(saturday, start)
      const result = findOpenings({
        ...shop,
        durationMin,
        busy: [{ startUtc: requested, endUtc: dubai(saturday, end) }],
        requested,
      })
      expect(result.requestedFits).toBe(false)
      expect(result.openings).toHaveLength(3)
      expect(startTimes(result)[0]).toBe(Date.parse(dubai(saturday, next)))
    },
  )

  it('offers Monday at 10:00 for a Sunday request', () => {
    const result = findOpenings({
      ...shop,
      requested: dubai('2026-12-06', '10:00'),
    })
    expect(result.requestedFits).toBe(false)
    expect(startTimes(result)[0]).toBe(Date.parse(dubai(monday, '10:00')))
  })

  it('skips a local holiday that would ordinarily be open', () => {
    const result = findOpenings({
      ...shop,
      requested: dubai(monday, '10:00'),
      closedDates: [monday],
    })
    expect(result.requestedFits).toBe(false)
    expect(startTimes(result)[0]).toBe(Date.parse(dubai('2026-12-08', '10:00')))
  })

  it.each([
    ['19:15', true],
    ['19:30', false],
    ['10:07', false],
    ['09:45', false],
  ] as const)('checks a 45-minute request at %s', (time, fits) => {
    const result = findOpenings({
      ...shop,
      requested: dubai(saturday, time),
      count: 0,
    })
    expect(result).toEqual({ requestedFits: fits, openings: [] })
  })

  it('accepts equality at both buffer boundaries', () => {
    const result = findOpenings({
      ...shop,
      from: dubai(saturday, '10:15'),
      busy: [
        {
          startUtc: dubai(saturday, '10:35'),
          endUtc: dubai(saturday, '10:55'),
        },
      ],
      durationMin: 15,
      count: 2,
    })
    expect(result.requestedFits).toBe(false)
    expect(startTimes(result)).toEqual(
      ['10:15', '11:00'].map((t) => Date.parse(dubai(saturday, t))),
    )
  })

  it('prefers later starts, using earlier same-day starts only to fill remaining places', () => {
    const input: FindOpeningsInput = {
      ...shop,
      hours: {
        6: { open: '18:45', close: '20:00' },
        1: { open: '10:00', close: '10:45' },
      },
      from: dubai(saturday, '18:45'),
      requested: dubai(saturday, '19:00'),
      horizonDays: 3,
    }
    const later = [dubai(saturday, '19:15'), dubai(monday, '10:00')].map(
      Date.parse,
    )
    const limited = findOpenings({ ...input, count: 2 })
    expect(limited.requestedFits).toBe(true)
    expect(startTimes(limited)).toEqual(later)
    expect(startTimes(findOpenings(input))).toEqual([
      Date.parse(input.from),
      ...later,
    ])
  })

  it('produces identical results without modifying its input', () => {
    const input = {
      ...structuredClone(shop),
      busy: [
        {
          startUtc: dubai(saturday, '13:00'),
          endUtc: dubai(saturday, '14:00'),
        },
        {
          startUtc: dubai(saturday, '10:00'),
          endUtc: dubai(saturday, '11:00'),
        },
      ],
    }
    const original = structuredClone(input)
    const result = findOpenings(input)
    expect(findOpenings(input)).toEqual(result)
    expect(input).toEqual(original)
  })

  it('offers the first real start after a nonexistent spring-forward request', () => {
    const result = findOpenings({
      ...shop,
      tz: 'America/New_York',
      from: '2026-03-08T00:00',
      requested: '2026-03-08T02:15',
      hours: { 7: { open: '00:00', close: '05:00' } },
      count: 1,
    })
    expect(result.requestedFits).toBe(false)
    expect(startTimes(result)).toEqual([Date.parse('2026-03-08T03:00:00-04:00')])
  })

  it.each([
    [
      'spring gap',
      '2026-03-08',
      '01:00',
      '04:00',
      ['06:00', '06:30', '07:00', '07:30'],
    ],
    [
      'autumn repeat',
      '2026-11-01',
      '00:30',
      '02:30',
      ['04:30', '05:00', '05:30', '06:00', '06:30', '07:00'],
    ],
  ] as const)(
    'returns all real half-hour starts through the %s in New York',
    (_transition, date, open, close, utcStarts) => {
      const tz = 'America/New_York'
      const result = findOpenings({
        ...shop,
        tz,
        hours: { 7: { open, close } },
        from: DateTime.fromISO(date, { zone: tz }).toUTC().toISO()!,
        gridMin: 30,
        durationMin: 30,
        horizonDays: 1,
        count: 10,
      })
      expect(startTimes(result)).toEqual(
        utcStarts.map((time) => Date.parse(`${date}T${time}:00Z`)),
      )
      for (const { startUtc, endUtc } of result.openings) {
        expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(30 * 60_000)
      }
    },
  )
})
