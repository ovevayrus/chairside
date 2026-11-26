import type { ActionResponse } from '@chairside/shared'
import { DateTime } from 'luxon'
import { matchesBooking, type CalendarAdapter } from '../calendar/adapter.js'
import { bookingEvent, bookingFor, type BookingRow } from '../db/bookings.js'
import type { RequestRow } from '../db/requests.js'
import { isUnendedBookingToday } from '../parse/parser.js'
import { finish, type ActionContext, type ActionRow } from './context.js'

export function currentBooking(
  ctx: ActionContext,
  row: RequestRow,
): BookingRow | undefined {
  const booking = bookingFor(ctx.store, row.booking_id)
  const now = ctx.store.now()
  if (
    booking?.status === 'active' &&
    booking.reply_status === 'sent' &&
    !booking.pending_action_id &&
    (row.intent === 'late'
      ? isUnendedBookingToday(
          booking,
          DateTime.fromJSDate(now, { zone: ctx.store.shop.timezone }),
        )
      : Date.parse(booking.slot_start_utc) > now.getTime())
  )
    return booking
}

export function bookingUnavailable(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
): ActionResponse {
  return ctx.store.transaction(() => {
    ctx.store.close(row.id, 'handled')
    return finish(ctx, action, {
      status: 'stale',
      receipt: 'Appointment is no longer available to change',
    })
  })
}

/** Persist the owner's intent before any calendar write. */
export function beginBookingChange(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  booking: BookingRow,
  state: 'calendar_pending' | 'cancel_pending',
  eventId?: string,
): boolean {
  const { store } = ctx
  return store.transaction(() => {
    const claimed = store.db
      .prepare(
        "UPDATE bookings SET pending_action_id=? WHERE id=? AND status='active' AND pending_action_id IS NULL",
      )
      .run(action.id, booking.id)
    if (!claimed.changes) return false
    const at = store.now().toISOString()
    store.db
      .prepare(
        'UPDATE actions SET state=?,planned_event_id=?,updated_at=? WHERE id=?',
      )
      .run(state, eventId ?? null, at, action.id)
    store.db
      .prepare("UPDATE requests SET status='executing',updated_at=? WHERE id=?")
      .run(at, row.id)
    return true
  })
}

async function removeOwnedEvent(
  calendar: CalendarAdapter,
  booking: BookingRow,
): Promise<void> {
  const ownership = bookingEvent(booking)
  const event = await calendar.getEvent(ownership.id)
  if (event && matchesBooking(event, ownership))
    await calendar.deleteEvent(ownership.id, event.etag)
}

/** Only called after the replacement was committed. Failure leaves the marker set. */
export async function cleanupMovedEvent(
  ctx: ActionContext,
  previous: BookingRow,
): Promise<void> {
  if (!previous.cleanup_pending) return
  try {
    await removeOwnedEvent(ctx.calendar, previous)
  } catch {
    return
  }
  ctx.store.db
    .prepare(
      "UPDATE bookings SET cleanup_pending=0 WHERE id=? AND status='moved'",
    )
    .run(previous.id)
}

export async function cleanupForMove(
  ctx: ActionContext,
  row: RequestRow,
): Promise<void> {
  const previous = bookingFor(ctx.store, row.booking_id)
  if (previous) await cleanupMovedEvent(ctx, previous)
}

/** Undefined means the cancellation is committed and the reply is safe to send. */
export async function recordCancellation(
  ctx: ActionContext,
  action: ActionRow,
  booking: BookingRow,
): Promise<ActionResponse | undefined> {
  if (booking.status === 'cancelled') return
  if (booking.status !== 'active' || booking.pending_action_id !== action.id)
    throw new Error('Lost booking cancellation intent')
  try {
    await removeOwnedEvent(ctx.calendar, booking)
  } catch {
    return finish(
      ctx,
      action,
      { status: 'error', receipt: 'Cancellation unconfirmed · Check Calendar' },
      'cancel_pending',
    )
  }
  const updated = ctx.store.db
    .prepare(
      "UPDATE bookings SET status='cancelled',pending_action_id=NULL WHERE id=? AND status='active' AND pending_action_id=?",
    )
    .run(booking.id, action.id)
  if (!updated.changes) throw new Error('Lost booking cancellation intent')
}

export async function cancelBooking(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
): Promise<ActionResponse | undefined> {
  const booking = currentBooking(ctx, row)
  if (
    !booking ||
    !beginBookingChange(ctx, action, row, booking, 'cancel_pending')
  )
    return bookingUnavailable(ctx, action, row)
  return recordCancellation(ctx, action, {
    ...booking,
    pending_action_id: action.id,
  })
}
