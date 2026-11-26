import { randomUUID } from 'node:crypto'
import { CardSchema, type Card } from '@chairside/shared'
import { DateTime } from 'luxon'
import { freeBusyExcluding, type CalendarAdapter } from '../calendar/adapter.js'
import { bookingEvent, type BookingRow } from '../db/bookings.js'
import type { ParseResult } from '../parse/parser.js'
import type { ShopConfig } from '../shop/config.js'
import { findOpenings, type Interval } from '../slots/engine.js'

export interface Proposal {
  id: string
  kind: string
  slot_start_utc: string | null
  slot_end_utc: string | null
  label: string
}

export interface CardRequest {
  id: string
  version: number
  customer_first_name: string
  intent: string
  service_id: string | null
  requested_start_utc: string | null
  status: string
}

export type ReplyBlock = 'rights' | 'window'

export function proposal(
  kind: string,
  label: string,
  slot?: Interval,
): Proposal {
  return {
    id: randomUUID().replaceAll('-', ''),
    kind,
    slot_start_utc: slot?.startUtc ?? null,
    slot_end_utc: slot?.endUtc ?? null,
    label,
  }
}

function localSlot(utc: string, shop: ShopConfig, format: string): string {
  return DateTime.fromISO(utc, { zone: shop.timezone })
    .setLocale('en')
    .toFormat(format)
}

function serviceFor(shop: ShopConfig, id: string | undefined | null) {
  return shop.services.find((service) => service.id === id)
}

/** Query exactly the local dates searched by the engine, including both buffers. */
async function availableOpenings(
  shop: ShopConfig,
  calendar: CalendarAdapter,
  now: Date,
  durationMin: number,
  requested: string | undefined,
  blocked: Interval[],
  booking?: BookingRow,
) {
  const startDay = DateTime.fromMillis(
    Math.max(now.getTime(), requested ? Date.parse(requested) : now.getTime()),
    { zone: shop.timezone },
  ).startOf('day')
  const horizonDays = 7
  const from = startDay.minus({ minutes: shop.bufferMin }).toUTC().toISO()!
  const to = startDay
    .plus({ days: horizonDays, minutes: shop.bufferMin })
    .toUTC()
    .toISO()!
  const availability = await (
    booking
      ? freeBusyExcluding(calendar, from, to, bookingEvent(booking))
      : calendar.freeBusy(from, to)
  ).catch(() => ({ ok: false as const }))
  if (!availability.ok) return
  const input = {
    hours: shop.hours,
    tz: shop.timezone,
    durationMin,
    bufferMin: shop.bufferMin,
    gridMin: shop.gridMin,
    busy: availability.busy,
    from: now.toISOString(),
    requested,
    horizonDays,
    count: 2,
  }
  if (!booking)
    return findOpenings({ ...input, busy: [...input.busy, ...blocked] })
  const openings = findOpenings(input)
  // A press can lose a race before the competing event becomes visible in the
  // next calendar read. Use the synthetic block only when that read missed it.
  return blocked.length && openings.requestedFits
    ? findOpenings({ ...input, busy: [...input.busy, ...blocked] })
    : openings
}

export async function planMoveProposals(
  booking: BookingRow,
  requested: string | undefined,
  shop: ShopConfig,
  calendar: CalendarAdapter,
  now: Date,
  blocked: Interval[] = [],
  requestedDayUtc = booking.slot_start_utc,
): Promise<Proposal[]> {
  const dismiss = proposal('not_now', 'Not now')
  const bookedStart = Date.parse(booking.slot_start_utc)
  const durationMs = Date.parse(booking.slot_end_utc) - bookedStart
  if (!(durationMs > 0)) return [dismiss]
  if (!requested)
    return [
      proposal('ask_time', 'Ask what time suits', {
        startUtc: requestedDayUtc,
        endUtc: requestedDayUtc,
      }),
      dismiss,
    ]
  const availability = await availableOpenings(
    shop,
    calendar,
    now,
    durationMs / 60_000,
    requested,
    blocked,
    booking,
  )
  if (!availability) return [proposal('calendar_error', 'Not now')]
  const requestedMs = Date.parse(requested)
  const slot = {
    startUtc: requested,
    endUtc: new Date(requestedMs + durationMs).toISOString(),
  }
  if (availability.requestedFits && requestedMs !== bookedStart)
    return [proposal('move', 'Move & reply', slot), dismiss]
  const next = availability.openings.find(({ startUtc }) => {
    const start = Date.parse(startUtc)
    return start > requestedMs && start !== bookedStart
  })
  return [
    next
      ? proposal(
          'move_offer',
          `Offer ${localSlot(next.startUtc, shop, 'ccc d LLL HH:mm')}`,
          next,
        )
      : proposal('ask_time', 'Ask for another time', slot),
    dismiss,
  ]
}

export async function planProposals(
  parsed: ParseResult,
  shop: ShopConfig,
  calendar: CalendarAdapter,
  now: Date,
  blocked: Interval[] = [],
  booking?: BookingRow,
): Promise<Proposal[]> {
  if (parsed.intent === 'move' && booking)
    return planMoveProposals(
      booking,
      parsed.startUtc,
      shop,
      calendar,
      now,
      blocked,
      parsed.requestedDayUtc,
    )
  const dismiss = proposal('not_now', 'Not now')
  if (parsed.intent === 'cancel' && booking)
    return [
      proposal('cancel', 'Cancel & reply', {
        startUtc: booking.slot_start_utc,
        endUtc: booking.slot_end_utc,
      }),
      dismiss,
    ]
  if (parsed.intent !== 'book') return [dismiss]
  const service = serviceFor(shop, parsed.serviceId ?? shop.defaultServiceId)
  if (!service) return [dismiss]
  const requested = parsed.startUtc
  const availability = await availableOpenings(
    shop,
    calendar,
    now,
    service.durationMin,
    requested,
    blocked,
  )
  if (!availability) return [proposal('calendar_error', 'Not now')]
  const { requestedFits, openings } = availability
  const offer = (slot: Interval, prefix = 'Offer') =>
    proposal(
      'offer',
      `${prefix} ${localSlot(slot.startUtc, shop, 'ccc d LLL HH:mm')}`,
      slot,
    )
  if (!requested) {
    const dayMissing = parsed.needs.includes('date')
    const ask = dayMissing
      ? proposal('ask_day', 'Ask which day suits', openings[0])
      : proposal(
          'ask_time',
          'Ask what time suits',
          parsed.requestedDayUtc
            ? {
                startUtc: parsed.requestedDayUtc,
                endUtc: parsed.requestedDayUtc,
              }
            : openings[0],
        )
    return [
      ask,
      ...(openings[0] ? [offer(openings[0], 'Offer earliest')] : []),
      dismiss,
    ]
  }
  const slot = {
    startUtc: requested,
    endUtc: new Date(
      Date.parse(requested) + service.durationMin * 60_000,
    ).toISOString(),
  }
  if (requestedFits) {
    const next =
      openings.find((o) => Date.parse(o.startUtc) > Date.parse(requested)) ??
      openings[0]
    return [
      proposal('book', 'Book & reply', slot),
      ...(next ? [offer(next)] : []),
      dismiss,
    ]
  }
  return [
    ...openings.map((opening) => offer(opening)),
    proposal('ask_time', 'Ask for another time', slot),
  ]
}

/** Firmware renders printable ASCII and these confirmed display symbols. */
export function displayText(value: string, limit = 40): string {
  return value
    .normalize('NFKD')
    .replace(/\s+/gu, ' ')
    .replace(/[^ -~●○■□▶━─│·]/gu, '')
    .trim()
    .slice(0, limit)
    .trimEnd()
}

export function buildCard(
  request: CardRequest,
  proposals: Proposal[],
  shop: ShopConfig,
  replyBlock?: ReplyBlock,
  index = 1,
  total = 1,
  booking?: BookingRow,
): Card {
  const service = serviceFor(shop, request.service_id)
  const name = displayText(request.customer_first_name, 24) || 'Customer'
  const lines = [
    (service && request.intent === 'book') || booking
      ? `${name} · ${service?.name ?? 'Appointment'}`
      : name,
  ]
  let header = 'NEW REQUEST'
  let actions = proposals.map(({ id, label }) => ({
    id,
    label: displayText(label),
  }))
  const dismiss = proposals.find(
    (p) => p.kind === 'not_now' || p.kind === 'calendar_error',
  )
  const retry = proposals.find((p) => p.kind.startsWith('retry_'))
  const retryBooking =
    retry?.kind === 'retry_book' || retry?.kind === 'retry_offer_accepted'
  const changeResult =
    retry?.kind === 'retry_move' || retry?.kind === 'retry_move_offer_accepted'
      ? 'Moved'
      : retry?.kind === 'retry_cancel'
        ? 'Cancelled'
        : undefined
  if (request.status === 'reply_unknown') {
    const booked = proposals.some((p) => p.kind === 'unknown_book')
    if (booked) header = request.intent === 'move' ? 'MOVED' : 'BOOKED'
    else
      header =
        request.intent === 'cancel' && booking?.status === 'cancelled'
          ? 'CANCELLED'
          : 'NEEDS YOU'
    lines.push('Reply status unknown · check Telegram')
  } else if (replyBlock) {
    header = "CAN'T REPLY"
    if (changeResult) lines.push(`${changeResult} · reply not sent`)
    else if (retryBooking && request.status === 'reply_not_sent')
      lines.push('Booked · reply not sent')
    lines.push(
      replyBlock === 'window'
        ? "Can't reply in Telegram after 24 h"
        : 'Telegram reply permission unavailable',
    )
    actions = [{ id: dismiss?.id ?? 'not_now', label: 'Not now' }]
  } else if (retry) {
    header = 'NEEDS YOU'
    if (retry.slot_start_utc)
      lines.push(localSlot(retry.slot_start_utc, shop, 'ccc d LLL · HH:mm'))
    if (changeResult) lines.push(`${changeResult} · reply not sent`)
    else
      lines.push(
        request.status === 'reply_not_sent' && retryBooking
          ? 'Booked, reply not sent · Send now?'
          : 'Reply not sent',
      )
  } else if (
    request.status === 'slot_taken_accepted' &&
    request.requested_start_utc
  ) {
    // The customer accepted an offer, then the recheck found the slot gone.
    header = 'NEEDS YOU'
    const when = localSlot(request.requested_start_utc, shop, 'ccc HH:mm')
    lines[0] = `${displayText(name, 18)} said yes to ${when}`
    lines.push('but it was just taken')
  } else if (request.intent === 'cancel') {
    header = 'WANTS TO CANCEL'
    if (booking)
      lines.push(localSlot(booking.slot_start_utc, shop, 'ccc d LLL · HH:mm'))
  } else if (request.intent === 'unknown') {
    header = 'NEEDS YOU'
  } else if (
    request.status === 'calendar_error' ||
    proposals.some((p) => p.kind === 'calendar_error')
  ) {
    header = 'NEEDS YOU'
    lines.push('Calendar unavailable')
  } else if (request.intent === 'move' && booking) {
    header = 'WANTS TO MOVE'
    const oldStart = booking.slot_start_utc
    const newStart = request.requested_start_utc
    const oldWhen = localSlot(oldStart, shop, 'ccc d LLL HH:mm')
    if (newStart) {
      const sameDay =
        localSlot(oldStart, shop, 'yyyy-MM-dd') ===
        localSlot(newStart, shop, 'yyyy-MM-dd')
      const availability = proposals.some((p) => p.kind === 'move')
        ? '● free'
        : '○ taken'
      if (Date.parse(oldStart) === Date.parse(newStart))
        lines.push(`${oldWhen} · Already booked`)
      else if (sameDay)
        lines.push(
          `${oldWhen} ▶ ${localSlot(newStart, shop, 'HH:mm')} · ${availability}`,
        )
      else
        lines.push(
          oldWhen,
          `▶ ${localSlot(newStart, shop, 'ccc d LLL HH:mm')} · ${availability}`,
        )
    } else {
      lines.push(oldWhen)
    }
  } else if (request.requested_start_utc && service) {
    const date = localSlot(
      request.requested_start_utc,
      shop,
      'ccc d LLL · HH:mm',
    )
    const availability = proposals.some((p) => p.kind === 'book')
      ? `● free (${service.durationMin} min)`
      : '○ taken'
    lines.push(`${date} · ${availability}`)
  }
  return CardSchema.parse({
    requestId: request.id,
    version: request.version,
    header,
    lines: lines.map((line) => displayText(line)),
    actions,
    index,
    total,
  })
}
