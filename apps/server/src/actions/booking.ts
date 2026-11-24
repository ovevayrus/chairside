import type { ActionResponse } from '@chairside/shared'
import { isOurs, type InsertInput } from '../calendar/adapter.js'
import { eventIdFor } from '../calendar/eventId.js'
import type { RequestRow } from '../db/requests.js'
import { proposal, type Proposal } from '../requests/cards.js'
import {
  finish,
  replaceCard,
  taken,
  type ActionContext,
  type ActionRow,
} from './context.js'

export function plannedBooking(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): InsertInput | undefined {
  const service = ctx.store.shop.services.find(
    ({ id }) => id === (row.service_id ?? ctx.store.shop.defaultServiceId),
  )
  // During reconciliation the historical service may have left the menu. Its
  // persisted interval and booking marker are sufficient to identify the event.
  if (
    (!service && !action.planned_event_id) ||
    !p.slot_start_utc ||
    !p.slot_end_utc
  )
    return
  const start = Date.parse(p.slot_start_utc)
  const end = Date.parse(p.slot_end_utc)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return
  return {
    id:
      action.planned_event_id ??
      eventIdFor(row.shop_id, `${row.id}:${action.id}`, p.slot_start_utc),
    startUtc: p.slot_start_utc,
    endUtc: p.slot_end_utc,
    summary: `Chairside · ${row.customer_first_name} · ${service?.name ?? 'Appointment'}`,
    privateProps: { chairsideBookingId: action.id, requestId: row.id },
  }
}

export function calendarFailed(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  receipt: string,
): ActionResponse {
  return ctx.store.transaction(() => {
    const card = replaceCard(ctx, row, 'pending', [
      proposal('calendar_error', 'Not now'),
    ])
    return finish(ctx, action, { status: 'error', card, receipt }, 'failed')
  })
}

function uncertain(ctx: ActionContext, action: ActionRow): ActionResponse {
  // Leave the planned ID available to reconciliation. An ambiguous insert,
  // read or delete must never expose a second booking action or a send.
  return finish(
    ctx,
    action,
    { status: 'error', receipt: 'Booking unconfirmed · Check Calendar' },
    'calendar_pending',
  )
}

/** Shared by the live path and startup after the planned event was found. */
export async function verifyAndRecord(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
  input: InsertInput,
): Promise<ActionResponse | undefined> {
  let events
  try {
    events = await ctx.calendar.listEvents(input.startUtc, input.endUtc)
  } catch {
    return uncertain(ctx, action)
  }
  if (
    events.some(
      (event) => !(Date.parse(event.endUtc) > Date.parse(event.startUtc)),
    )
  ) {
    return uncertain(ctx, action)
  }
  const overlapping = events.filter(
    (event) =>
      Date.parse(event.startUtc) < Date.parse(input.endUtc) &&
      Date.parse(event.endUtc) > Date.parse(input.startUtc),
  )
  if (overlapping.some((event) => event.id !== input.id)) {
    try {
      // A human may have moved/repurposed the event after the insert.
      const ours = await ctx.calendar.getEvent(input.id)
      if (ours && isOurs(ours, input)) await ctx.calendar.deleteEvent(input.id)
    } catch {
      return uncertain(ctx, action)
    }
    ctx.store.db.prepare('DELETE FROM bookings WHERE id=?').run(action.id)
    return taken(ctx, action, row, p)
  }
  if (
    !overlapping.some((event) => event.id === input.id && isOurs(event, input))
  ) {
    return uncertain(ctx, action)
  }
  ctx.store.db
    .prepare(
      `INSERT INTO bookings
    (id,shop_id,request_id,calendar_event_id,slot_start_utc,slot_end_utc,reply_status,created_at)
    VALUES (?,?,?,?,?,?,'not_sent',?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      action.id,
      row.shop_id,
      row.id,
      input.id,
      input.startUtc,
      input.endUtc,
      ctx.store.now().toISOString(),
    )
}

/** An undefined result means the event is durably recorded and may now be confirmed. */
export async function reserve(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): Promise<ActionResponse | undefined> {
  const { store, calendar } = ctx
  const input = plannedBooking(ctx, action, row, p)
  if (!input)
    return calendarFailed(ctx, action, row, 'Appointment details unavailable')
  const start = Date.parse(input.startUtc)
  if (start < store.now().getTime()) return taken(ctx, action, row, p)
  const buffer = store.shop.bufferMin * 60_000
  const from = start - buffer
  const to = Date.parse(input.endUtc) + buffer
  const availability = await calendar
    .freeBusy(new Date(from).toISOString(), new Date(to).toISOString())
    .catch(() => ({ ok: false as const }))
  if (!availability.ok)
    return calendarFailed(ctx, action, row, 'Calendar unavailable')
  for (const busy of availability.busy) {
    const begin = Date.parse(busy.startUtc)
    const end = Date.parse(busy.endUtc)
    if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) {
      return calendarFailed(ctx, action, row, 'Calendar unavailable')
    }
    if (begin < to && end > from) return taken(ctx, action, row, p)
  }
  store.transaction(() => {
    const at = store.now().toISOString()
    store.db
      .prepare(
        "UPDATE actions SET state='calendar_pending',planned_event_id=?,updated_at=? WHERE id=?",
      )
      .run(input.id, at, action.id)
    store.db
      .prepare("UPDATE requests SET status='executing',updated_at=? WHERE id=?")
      .run(at, row.id)
  })
  let result
  try {
    result = await calendar.insertEvent(input)
  } catch {
    return uncertain(ctx, action)
  }
  // The adapter resolves a 409 by fetching the existing event and checking
  // the private ownership marker and exact interval.
  if (result.status === 'conflict') return taken(ctx, action, row, p)
  if (result.event.id !== input.id || !isOurs(result.event, input))
    return uncertain(ctx, action)
  ctx.checkpoint?.('after_insert')
  return verifyAndRecord(ctx, action, row, p, input)
}
