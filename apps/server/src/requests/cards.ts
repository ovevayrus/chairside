import { randomUUID } from 'node:crypto'
import { CardSchema, type Card } from '@chairside/shared'
import { DateTime } from 'luxon'
import type { CalendarAdapter } from '../calendar/adapter.js'
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
export async function planProposals(
  parsed: ParseResult & { requestedDayUtc?: string },
  shop: ShopConfig,
  calendar: CalendarAdapter,
  now: Date,
  blocked: Interval[] = [],
): Promise<Proposal[]> {
  const dismiss = proposal('not_now', 'Not now')
  if (parsed.intent !== 'book') return [dismiss]
  const service = serviceFor(shop, parsed.serviceId ?? shop.defaultServiceId)
  if (!service) return [dismiss]
  const requested = parsed.startUtc
  const startDay = DateTime.fromMillis(
    Math.max(now.getTime(), requested ? Date.parse(requested) : now.getTime()),
    { zone: shop.timezone },
  ).startOf('day')
  const horizonDays = 7
  const availability = await calendar
    .freeBusy(
      startDay.minus({ minutes: shop.bufferMin }).toUTC().toISO()!,
      startDay
        .plus({ days: horizonDays, minutes: shop.bufferMin })
        .toUTC()
        .toISO()!,
    )
    .catch(() => ({ ok: false as const }))
  if (!availability.ok) return [proposal('calendar_error', 'Not now')]
  const { requestedFits, openings } = findOpenings({
    hours: shop.hours,
    tz: shop.timezone,
    durationMin: service.durationMin,
    bufferMin: shop.bufferMin,
    gridMin: shop.gridMin,
    busy: [...availability.busy, ...blocked],
    from: now.toISOString(),
    requested,
    horizonDays,
    count: 2,
  })
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
): Card {
  const service = serviceFor(shop, request.service_id)
  const name = displayText(request.customer_first_name, 24) || 'Customer'
  const lines = [
    service && request.intent === 'book' ? `${name} · ${service.name}` : name,
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
  if (request.status === 'reply_unknown') {
    const booked = proposals.some((p) => p.kind === 'unknown_book')
    header = booked ? 'BOOKED' : 'NEEDS YOU'
    lines.push('Reply status unknown · check Telegram')
  } else if (replyBlock) {
    header = "CAN'T REPLY"
    if (retryBooking && request.status === 'reply_not_sent')
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
  } else if (request.intent === 'unknown') {
    header = 'NEEDS YOU'
  } else if (
    request.status === 'calendar_error' ||
    proposals.some((p) => p.kind === 'calendar_error')
  ) {
    header = 'NEEDS YOU'
    lines.push('Calendar unavailable')
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
