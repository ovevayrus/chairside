import type { ActionResponse } from '@chairside/shared'
import {
  freeBusyExcluding,
  isOurs,
  matchesBooking,
  type InsertInput,
} from '../calendar/adapter.js'
import { eventIdFor } from '../calendar/eventId.js'
import {
  bookingEvent,
  releaseBookingChange,
  type BookingRow,
} from '../db/bookings.js'
import type { RequestRow } from '../db/requests.js'
import { proposal, type Proposal } from '../requests/cards.js'
import { findOpenings } from '../slots/engine.js'
import {
  beginBookingChange,
  bookingUnavailable,
  cleanupForMove,
  currentBooking,
} from './changes.js'
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
    (!service && !row.booking_id && !action.planned_event_id) ||
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
    releaseBookingChange(ctx.store, row.booking_id, action.id)
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
  previous?: BookingRow,
): Promise<ActionResponse | undefined> {
  const start = Date.parse(input.startUtc)
  const end = Date.parse(input.endUtc)
  const buffer = previous ? ctx.store.shop.bufferMin * 60_000 : 0
  let events
  try {
    events = await ctx.calendar.listEvents(
      new Date(start - buffer).toISOString(),
      new Date(end + buffer).toISOString(),
    )
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
  const ownership = previous && bookingEvent(previous)
  const overlapping = events.filter(
    (event) =>
      !event.transparent &&
      !(ownership && matchesBooking(event, ownership)) &&
      Date.parse(event.startUtc) < end + buffer &&
      Date.parse(event.endUtc) > start - buffer,
  )
  if (overlapping.some((event) => event.id !== input.id)) {
    try {
      // A human may have moved/repurposed the event after the insert.
      const ours = await ctx.calendar.getEvent(input.id)
      if (ours && isOurs(ours, input))
        await ctx.calendar.deleteEvent(input.id, ours.etag)
    } catch {
      return uncertain(ctx, action)
    }
    if (!previous)
      ctx.store.db.prepare('DELETE FROM bookings WHERE id=?').run(action.id)
    return taken(ctx, action, row, p)
  }
  if (
    !overlapping.some((event) => event.id === input.id && isOurs(event, input))
  ) {
    return uncertain(ctx, action)
  }
  const { store } = ctx
  store.transaction(() => {
    if (previous) {
      const updated = store.db
        .prepare(
          `UPDATE bookings SET status='moved',cleanup_pending=1,pending_action_id=NULL
          WHERE id=? AND status='active' AND pending_action_id=?`,
        )
        .run(previous.id, action.id)
      if (!updated.changes) throw new Error('Lost booking move intent')
    }
    store.db
      .prepare(
        `INSERT INTO bookings
        (id,shop_id,request_id,calendar_event_id,slot_start_utc,slot_end_utc,reply_status,created_at,service_id,replaced_booking_id)
        VALUES (?,?,?,?,?,?,'not_sent',?,?,?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        action.id,
        row.shop_id,
        row.id,
        input.id,
        input.startUtc,
        input.endUtc,
        store.now().toISOString(),
        previous?.service_id ?? row.service_id ?? store.shop.defaultServiceId,
        previous?.id ?? null,
      )
  })
}

/** An undefined result means the event is durably recorded and may now be confirmed. */
export async function reserve(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
  previous?: BookingRow,
): Promise<ActionResponse | undefined> {
  const { store, calendar } = ctx
  const input = plannedBooking(ctx, action, row, p)
  if (!input)
    return calendarFailed(ctx, action, row, 'Appointment details unavailable')
  const start = Date.parse(input.startUtc)
  if (start < store.now().getTime()) return taken(ctx, action, row, p)
  if (previous) {
    const duration =
      Date.parse(previous.slot_end_utc) - Date.parse(previous.slot_start_utc)
    if (
      Date.parse(input.endUtc) - start !== duration ||
      start === Date.parse(previous.slot_start_utc) ||
      !findOpenings({
        hours: store.shop.hours,
        tz: store.shop.timezone,
        durationMin: duration / 60_000,
        bufferMin: store.shop.bufferMin,
        gridMin: store.shop.gridMin,
        busy: [],
        from: store.now().toISOString(),
        requested: input.startUtc,
        allowOffGridRequest: p.kind === 'late_shift',
        horizonDays: 0,
        count: 0,
      }).requestedFits
    )
      return taken(ctx, action, row, p)
  }
  const buffer = store.shop.bufferMin * 60_000
  const from = start - buffer
  const to = Date.parse(input.endUtc) + buffer
  const fromUtc = new Date(from).toISOString()
  const toUtc = new Date(to).toISOString()
  const availability = previous
    ? await freeBusyExcluding(calendar, fromUtc, toUtc, bookingEvent(previous))
    : await calendar
        .freeBusy(fromUtc, toUtc)
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
  if (previous) {
    if (
      !beginBookingChange(
        ctx,
        action,
        row,
        previous,
        'calendar_pending',
        input.id,
      )
    )
      return bookingUnavailable(ctx, action, row)
  } else {
    store.transaction(() => {
      const at = store.now().toISOString()
      store.db
        .prepare(
          "UPDATE actions SET state='calendar_pending',planned_event_id=?,updated_at=? WHERE id=?",
        )
        .run(input.id, at, action.id)
      store.db
        .prepare(
          "UPDATE requests SET status='executing',updated_at=? WHERE id=?",
        )
        .run(at, row.id)
    })
  }
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
  return verifyAndRecord(ctx, action, row, p, input, previous)
}

export async function moveBooking(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): Promise<ActionResponse | undefined> {
  const previous = currentBooking(ctx, row)
  if (!previous) return bookingUnavailable(ctx, action, row)
  const response = await reserve(ctx, action, row, p, previous)
  if (!response) await cleanupForMove(ctx, row)
  return response
}
