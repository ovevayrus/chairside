import { DateTime } from 'luxon'
import type { ShopConfig } from '../shop/config.js'
import { parseSchedule } from './schedule.js'
import { matchService } from './service.js'

export type ParseResult = {
  intent: 'book' | 'move' | 'cancel' | 'unknown'
  bookingId?: string
  serviceId?: string
  startUtc?: string
  requestedDayUtc?: string
  confidence: number
  needs: Array<'date' | 'time' | 'service'>
}

export interface BookingTarget {
  id: string
  service_id: string | null
  slot_start_utc: string
}

const moveCue =
  /\b(?:instead|move|reschedule|switch|earlier|later|rather|push\s+(?:it|back)|change\s+(?:the\s+time|my\s+(?:appointment|booking)|it))\b/i
const newBookingCue = /\b(?:also|another|too|as\s+well|again|book)\b/i
const otherCustomerCue =
  /\b(?:(?:someone|somebody)\s+else|for\s+(?:him|her|them)|(?:can|could)\s+(?:he|she|they)|(?:my|our)\s+(?:(?:older|younger|little)\s+)?(?:brother|sister|friend|son|daughter|partner|husband|wife|dad|mom|mum|father|mother|child|kid|cousin|nephew|niece))\b/i
const serviceChangeCue = /\b(?:switch|swap|change)\b[^.!?]*?\b(?:to|for)\s+/i
const substitutionCue = /\binstead\b(?!\s+of\s+\d)/i
const shiftVerb =
  /\b(?<verb>push(?:\s+it)?\s+back|bring(?:\s+it)?\s+forward)\b/i
const shiftUnit = String.raw`(?:hours?|hrs?|minutes?|mins?)`
const shiftAmount = String.raw`(?<amount>half\s+an?\s+hour|(?:an?|\d+)\s+${shiftUnit})`
const commandedShift = new RegExp(
  String.raw`${shiftVerb.source}\s+(?:by\s+)?${shiftAmount}\b(?!\s+(?:and\b|or\b|\d|half\b|an?\s+${shiftUnit}\b))`,
  'i',
)
const comparativeShift = new RegExp(
  String.raw`(?<![\w.+-])${shiftAmount}\s+(?<direction>earlier|later)\b`,
  'i',
)
const durationCue = new RegExp(
  String.raw`\b${shiftUnit}\s+(?:earlier|later)\b`,
  'i',
)
const shiftUnitCue = new RegExp(String.raw`\b${shiftUnit}\b`, 'i')
const vagueShiftCue =
  /\b(?:(?:come|a\s+(?:bit|little|while))\s+(?:earlier|later)|(?:move|shift)\s+(?:it|me)\s+(?:back|forward))\b/i

function readMoveOffset(text: string): number | undefined {
  const command = commandedShift.exec(text)?.groups
  const comparative = comparativeShift.exec(text)
  // A supported amount at the end of a compound or choice is ambiguous.
  if (
    !command &&
    comparative &&
    /\b(?:and|or|of|hours?|hrs?|minutes?|mins?)\s*$/i.test(
      text.slice(0, comparative.index),
    )
  )
    return undefined
  const comparison = comparative?.groups
  const amount = command?.amount ?? comparison?.amount
  if (!amount) return undefined

  const [quantity = '', unit = ''] = amount.toLowerCase().split(/\s+/)
  const minutes =
    quantity === 'half'
      ? 30
      : (/^an?$/.test(quantity) ? 1 : Number(quantity)) *
        (/^h/.test(unit) ? 60 : 1)
  const comparisonEarlier = comparison?.direction?.toLowerCase() === 'earlier'
  const earlier =
    command?.verb?.toLowerCase().startsWith('bring') ?? comparisonEarlier
  if (
    !Number.isSafeInteger(minutes) ||
    (command &&
      comparison &&
      (earlier !== comparisonEarlier ||
        amount.toLowerCase() !== comparison.amount?.toLowerCase()))
  )
    return undefined
  return earlier ? -minutes : minutes
}

function moveStart(
  text: string,
  now: DateTime,
  shop: ShopConfig,
  booked: DateTime,
  schedule: ReturnType<typeof parseSchedule>,
): Pick<ParseResult, 'startUtc' | 'requestedDayUtc'> {
  const fallbackDay = schedule.explicitDay
    ? DateTime.fromISO(schedule.explicitDay, { zone: shop.timezone })
    : booked
  // Chrono treats "Monday to 5pm" as a range starting on Monday. For a
  // move, the words after "to" name the destination.
  const destination = text.replace(/^.*\bto\s+/is, '')
  const destinationSchedule = parseSchedule(
    destination,
    now,
    shop,
    true,
    fallbackDay,
  )
  const requested =
    destinationSchedule.hasTime || destinationSchedule.explicitDay
      ? destinationSchedule
      : schedule
  const day = requested.explicitDay
    ? DateTime.fromISO(requested.explicitDay, { zone: shop.timezone })
    : fallbackDay
  const sameClock = day.set({ hour: booked.hour, minute: booked.minute })
  const offset = readMoveOffset(text)
  const unresolved = {
    requestedDayUtc: day.startOf('day').toUTC().toISO() ?? undefined,
  }
  if (
    offset === undefined &&
    (schedule.hasRelative ||
      durationCue.test(text) ||
      (shiftVerb.test(text) && shiftUnitCue.test(text)) ||
      (!requested.hasTime &&
        ((shiftVerb.test(text) &&
          (!requested.explicitDay || destination === text)) ||
          vagueShiftCue.test(destination))))
  )
    return unresolved
  const start =
    offset !== undefined
      ? sameClock.plus({ minutes: offset })
      : requested.startUtc
        ? DateTime.fromISO(requested.startUtc, { zone: shop.timezone })
        : sameClock
  return start.toISODate() === day.toISODate()
    ? { startUtc: start.toUTC().toISO() ?? undefined }
    : unresolved
}

export function parseRequest(
  text: string,
  now: Date,
  shop: ShopConfig,
  bookings: readonly BookingTarget[] = [],
): ParseResult {
  const service = matchService(text, shop.services)
  const booking = /\b(?:book|appointment)\b/i.test(text)
  const newBooking = newBookingCue.test(text) || otherCustomerCue.test(text)
  const localNow = DateTime.fromJSDate(now, { zone: shop.timezone })
  const shifting = shiftVerb.test(text)
  const vagueShift = vagueShiftCue.test(text)
  const move = moveCue.test(text) || shifting || vagueShift
  const cancel = /\b(?:cancel|(?:can['’]?t|won['’]?t)\s+make\s+it)\b/i.test(
    text,
  )
  const firstBooking = bookings[0]
  const change = firstBooking && serviceChangeCue.exec(text)
  const replacement =
    change &&
    matchService(text.slice(change.index + change[0].length), shop.services)
  if (firstBooking && (cancel || replacement || (!newBooking && move))) {
    const localStart = (target: BookingTarget) =>
      DateTime.fromISO(target.slot_start_utc, { zone: shop.timezone })
    const schedule = parseSchedule(
      text,
      localNow,
      shop,
      true,
      cancel ? undefined : localStart(firstBooking),
    )
    // Upcoming bookings arrive in chronological order.
    const target =
      (schedule.explicitDay &&
        bookings.find(
          (candidate) =>
            localStart(candidate).toISODate() === schedule.explicitDay,
        )) ||
      firstBooking
    const serviceId = target.service_id ?? shop.defaultServiceId
    const differentService = !!service && service.id !== serviceId
    const changedService =
      replacement || (!newBooking && substitutionCue.test(text) && service)
    if (!cancel && changedService && changedService.id !== serviceId)
      return {
        intent: 'unknown',
        serviceId: changedService.id,
        confidence: 0,
        needs: [],
      }
    if (
      cancel ||
      (move &&
        !newBooking &&
        !differentService &&
        (schedule.hasTime ||
          schedule.explicitDay ||
          schedule.hasRelative ||
          shifting ||
          vagueShift ||
          durationCue.test(text)))
    ) {
      const time = cancel
        ? { startUtc: target.slot_start_utc }
        : moveStart(text, localNow, shop, localStart(target), schedule)
      return {
        intent: cancel ? 'cancel' : 'move',
        bookingId: target.id,
        serviceId,
        ...time,
        confidence: schedule.inferred ? 0.85 : 1,
        needs: time.startUtc ? [] : ['time'],
      }
    }
  }
  const schedule = parseSchedule(
    text,
    localNow,
    shop,
    !!service || booking || move,
  )
  let intent: ParseResult['intent'] = 'unknown'
  if (cancel) intent = 'cancel'
  else if (booking || service || schedule.hasTime || schedule.hasDate)
    intent = 'book'

  const needs: ParseResult['needs'] = []
  if (!schedule.hasDate) needs.push('date')
  if (!schedule.hasTime) needs.push('time')
  if (!service) needs.push('service')

  let confidence = 1
  if (schedule.inferred || service?.inferred) confidence = 0.85
  if (needs.length) confidence = 0.8 - needs.length * 0.1
  if (schedule.closedDay) confidence = Math.min(confidence, 0.5)
  if (intent === 'unknown') confidence = 0
  return {
    intent,
    serviceId: service?.id ?? shop.defaultServiceId,
    ...(schedule.startUtc && { startUtc: schedule.startUtc }),
    confidence,
    needs,
  }
}
