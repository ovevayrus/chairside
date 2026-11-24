import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRequest, type ParseResult } from '../src/parse/parser.js'
import { loadShopConfig } from '../src/shop/config.js'

const shop = loadShopConfig()
const saturday = '2026-11-28T09:00:00+04:00'
const parse = (text: string, now = saturday) =>
  parseRequest(text, new Date(now), shop)

type Fixture = {
  text: string
  now: string
  expected: Pick<ParseResult, 'intent' | 'serviceId' | 'startUtc'>
}

const phrases: Fixture[] = JSON.parse(
  readFileSync(
    new URL('../src/parse/fixtures/phrases.json', import.meta.url),
    'utf8',
  ),
)

describe('parseRequest', () => {
  it('exactly matches intent, service and UTC start on at least 95% of 40+ distinct fixtures', () => {
    expect(
      new Set(phrases.map(({ text }) => text)).size,
    ).toBeGreaterThanOrEqual(40)
    const misses = phrases.flatMap(({ text, now, expected }) => {
      const { intent, serviceId, startUtc, confidence } = parse(text, now)
      expect(confidence).toBeGreaterThanOrEqual(0)
      expect(confidence).toBeLessThanOrEqual(1)
      if (
        intent === expected.intent &&
        serviceId === expected.serviceId &&
        startUtc === expected.startUtc
      )
        return []
      return [{ text, now, expected, actual: { intent, serviceId, startUtc } }]
    })
    if (misses.length) console.warn('Parser fixture misses', misses)
    expect(
      (phrases.length - misses.length) / phrases.length,
    ).toBeGreaterThanOrEqual(0.95)
  })

  it('returns all five fields for a fully specified Dubai booking', () => {
    expect(parse('Can I get a skin fade Saturday 5 Dec at 3pm?')).toEqual({
      intent: 'book',
      serviceId: 'skin_fade',
      startUtc: '2026-12-05T11:00:00.000Z',
      confidence: 1,
      needs: [],
    })
  })

  it('retains a requested Sunday start and lowers confidence on the closed day', () => {
    const result = parse('Sunday 3pm haircut')
    expect(result.startUtc).toBe('2026-11-29T11:00:00.000Z')
    expect(result.needs).toEqual([])
    expect(result.confidence).toBeLessThan(0.6)
  })

  it.each([
    ['late Saturday', '4pm', '2026-11-28T20:30:00+04:00'],
    ['a closed Sunday', '4pm', '2026-11-29T09:00:00+04:00'],
    ['the exact current time', '4pm', '2026-11-28T16:00:00+04:00'],
    ['after closing time', '9pm', saturday],
  ])('asks for the date for a time-only request on %s', (_case, time, now) => {
    const result = parse('a cut at ' + time, now)
    expect(result.intent).toBe('book')
    expect(result.startUtc).toBeUndefined()
    expect(result.needs).toEqual(['date'])
    expect(result.confidence).toBeLessThan(1)
  })

  it('infers today for a future in-hours time without a date', () => {
    const result = parse('beard trim at 4pm')
    expect(result.startUtc).toBe('2026-11-28T12:00:00.000Z')
    expect(result.needs).toEqual([])
    expect(result.confidence).toBeLessThan(1)
  })

  it.each(['tmrw', 'tonight', 'Sat 5 Dec', '5/12'])(
    'asks for a time for %s',
    (day) => {
      const result = parse('a fade ' + day)
      expect(result.intent).toBe('book')
      expect(result.startUtc).toBeUndefined()
      expect(result.needs).toEqual(['time'])
      expect(result.confidence).toBeLessThan(1)
    },
  )

  it('uses the configured default and asks for the missing service', () => {
    const result = parseRequest('Saturday at noon', new Date(saturday), {
      ...shop,
      defaultServiceId: 'beard_trim',
    })
    expect(result.serviceId).toBe('beard_trim')
    expect(result.needs).toEqual(['service'])
    expect(result.confidence).toBeLessThan(1)
  })

  it.each([
    ['1', '09:00'],
    ['2', '10:00'],
    ['3', '11:00'],
    ['4', '12:00'],
    ['5', '13:00'],
    ['6', '14:00'],
    ['7', '15:00'],
    ['8', '16:00'],
    ['around 3', '11:00'],
    ['3ish', '11:00'],
    ['3:30', '11:30'],
    ['9', '05:00'],
    ['10', '06:00'],
    ['11', '07:00'],
    ['12', '08:00'],
  ])('resolves the ambiguous time %s against Dubai shop hours', (time, utc) => {
    const result = parse('skin fade Monday ' + time)
    expect(result.startUtc).toBe('2026-11-30T' + utc + ':00.000Z')
    expect(result.needs).toEqual([])
    if (time !== '12') expect(result.confidence).toBeLessThan(1)
  })

  it('resolves relative days across Dubai midnight and reads explicit dates as day/month', () => {
    const afterMidnight = '2026-11-28T22:00:00Z' // Sunday, 02:00 in Dubai.
    expect(parse('today noon cut', afterMidnight).startUtc).toBe(
      '2026-11-29T08:00:00.000Z',
    )
    expect(parse('tmrw noon cut', afterMidnight).startUtc).toBe(
      '2026-11-30T08:00:00.000Z',
    )
    expect(parse('5/12 15:00 cut').startUtc).toBe('2026-12-05T11:00:00.000Z')
    expect(parse('Sat 5 Dec 3pm cut').startUtc).toBe('2026-12-05T11:00:00.000Z')
  })

  it('matches whole service synonyms and allows a single typo in a long word', () => {
    expect(parse('HAIRCUT AND BEARD').serviceId).toBe('haircut_beard')
    for (const text of ['beardtrim', 'beardtrm'])
      expect(parse(text).serviceId).toBe('beard_trim')
    expect(parse('skinfode').serviceId).toBe('skin_fade')
    for (const text of ['fsde', 'cutlery', 'fadedness']) {
      const result = parse(text)
      expect(result.intent).toBe('unknown')
      expect(result.needs).toContain('service')
    }
  })
})
