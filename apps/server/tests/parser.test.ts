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

describe('parseRequest with a confirmed appointment', () => {
  const booked = {
    id: 'booking-1',
    service_id: 'skin_fade',
    slot_start_utc: '2026-12-05T11:00:00.000Z',
  }
  const now = new Date(saturday)

  it.each([
    ['can I come at 4 instead', '2026-12-05T12:00:00.000Z'],
    ['Could we move it to 5pm?', '2026-12-05T13:00:00.000Z'],
    ['can we push it to 16:30', '2026-12-05T12:30:00.000Z'],
    ['Can I reschedule to Sunday 2pm', '2026-11-29T10:00:00.000Z'],
    ['Can we change my appointment to Monday?', '2026-11-30T11:00:00.000Z'],
    ['Could we switch to 4?', '2026-12-05T12:00:00.000Z'],
    ['Could I come earlier at 2pm?', '2026-12-05T10:00:00.000Z'],
    ['Could I come later at 5pm?', '2026-12-05T13:00:00.000Z'],
    ["I'd rather come at 4pm", '2026-12-05T12:00:00.000Z'],
  ])('parses %j as a move to %s', (text, startUtc) => {
    expect(parseRequest(text, now, shop, [booked])).toMatchObject({
      intent: 'move',
      bookingId: booked.id,
      serviceId: booked.service_id,
      startUtc,
    })
  })

  it.each([
    'Can I get a haircut Saturday 23 Jan at 4pm?',
    'Can I change my payment method at 4pm?',
  ])('keeps %j as an ordinary booking request', (text) => {
    expect(parseRequest(text, now, shop, [booked]).intent).toBe('book')
  })

  it('does not move anything without a time or day', () => {
    expect(
      parseRequest('Can I move it?', now, shop, [booked]).bookingId,
    ).toBeUndefined()
  })

  it('keeps a move cue as an ordinary booking request when the chat has no booking', () => {
    const request = parseRequest('can I come at 4 instead', now, shop, [])
    expect(request.intent).toBe('book')
    expect(request.bookingId).toBeUndefined()
  })

  it('selects the booking on the named day for a move or cancellation', () => {
    const other = {
      id: 'booking-2',
      service_id: 'haircut',
      slot_start_utc: '2026-12-07T11:00:00.000Z',
    }
    for (const [intent, text, startUtc] of [
      [
        'move',
        'Can we switch Monday 7 Dec to 4pm?',
        '2026-12-07T12:00:00.000Z',
      ],
      ['cancel', 'Please cancel Monday 7 Dec', other.slot_start_utc],
    ] as const) {
      expect(parseRequest(text, now, shop, [booked, other])).toMatchObject({
        intent,
        bookingId: other.id,
        serviceId: other.service_id,
        startUtc,
      })
    }
  })
})

describe('parseRequest with a confirmed New York haircut', () => {
  const shop = loadShopConfig('../../config/shop.recording.json')
  const now = new Date('2027-01-20T10:00:00-05:00')
  const booked = {
    id: 'alex-haircut',
    service_id: 'haircut',
    slot_start_utc: '2027-01-23T20:00:00.000Z',
  }
  const parseWithBooking = (text: string) =>
    parseRequest(text, now, shop, [booked])

  it.each([
    [
      'Can I also get a beard trim later at 5?',
      'beard_trim',
      '2027-01-20T22:00:00.000Z',
    ],
    [
      'Can my brother come in later at 4?',
      'haircut',
      '2027-01-20T21:00:00.000Z',
    ],
    [
      'Can I book another haircut for later this week, Friday at 2?',
      'haircut',
      '2027-01-22T19:00:00.000Z',
    ],
    [
      'Could I get a skin fade later today at 4pm?',
      'skin_fade',
      '2027-01-20T21:00:00.000Z',
    ],
    [
      'Can you also do a beard trim Saturday 23 Jan at 5pm?',
      'beard_trim',
      '2027-01-23T22:00:00.000Z',
    ],
  ])('parses %j as a new %s booking at %s', (text, serviceId, startUtc) => {
    const result = parseWithBooking(text)
    expect(result).toMatchObject({ intent: 'book', serviceId, startUtc })
    expect(result.bookingId).toBeUndefined()
  })

  it.each([
    'Can I come in later at 4 too?',
    'Can I come in later at 4 as well?',
    'Can I come in again later at 4?',
    'Can we book a haircut later at 4?',
    'Can we book in later at 4?',
    'Can we book for later at 4?',
    'Can my friend come in later at 4?',
    'Can my son come in later at 4?',
    'Can he come in later at 4?',
    'Could I get a slot for him later at 4?',
    'Could I get a slot for her later at 4?',
  ])('treats %j as a new booking despite the later cue', (text) => {
    const result = parseWithBooking(text)
    expect(result.intent).toBe('book')
    expect(result.bookingId).toBeUndefined()
  })

  it.each([
    'Can I switch to a skin fade instead?',
    'Can I change from a haircut to a fade?',
  ])('routes the out-of-scope service change %j to unknown', (text) => {
    const result = parseWithBooking(text)
    expect(result.intent).toBe('unknown')
    expect(result.bookingId).toBeUndefined()
    expect(result.startUtc).toBeUndefined()
  })

  it.each([
    ['Can we push it back an hour?', '2027-01-23T21:00:00.000Z'],
    ['an hour later', '2027-01-23T21:00:00.000Z'],
    ['30 minutes later', '2027-01-23T20:30:00.000Z'],
    ['half an hour earlier', '2027-01-23T19:30:00.000Z'],
    ['bring it forward 30 minutes', '2027-01-23T19:30:00.000Z'],
    ['can I come at 4 instead', '2027-01-23T21:00:00.000Z'],
    ['Could we move it to 5pm?', '2027-01-23T22:00:00.000Z'],
    ['Could we move it to Friday at 2pm?', '2027-01-22T19:00:00.000Z'],
    ['Can I come Sunday instead?', '2027-01-24T20:00:00.000Z'],
    ['Can I reschedule to Sunday 2pm', '2027-01-24T19:00:00.000Z'],
    ['Could I come a bit later, 4:30?', '2027-01-23T21:30:00.000Z'],
    ['Actually can I do 3:30 instead of 3?', '2027-01-23T20:30:00.000Z'],
  ])('parses %j as a move to %s', (text, startUtc) => {
    expect(parseWithBooking(text)).toMatchObject({
      intent: 'move',
      bookingId: booked.id,
      serviceId: booked.service_id,
      startUtc,
    })
  })

  it.each([
    'Could I come 3-ish hours later?',
    'Can we push it back 3-ish hours?',
    'Can we push it back to a bit later?',
    'Can we push it back an hour, 30 minutes later?',
    'Can we push it back an hour and a half?',
    'Could I come a bit earlier?',
    'Can we push it back a couple of hours?',
    'Can I move it to later in the week?',
    'Can we push it back 12 hours?',
  ])('asks for a new time for %j', (text) => {
    const result = parseWithBooking(text)
    expect(result).toMatchObject({ intent: 'move', bookingId: booked.id })
    expect(result.startUtc).toBeUndefined()
    expect(result.needs).toContain('time')
  })

  it('still cancels the booked haircut on request', () => {
    expect(parseWithBooking('Sorry, I need to cancel')).toMatchObject({
      intent: 'cancel',
      bookingId: booked.id,
      serviceId: booked.service_id,
      startUtc: booked.slot_start_utc,
    })
  })
})
