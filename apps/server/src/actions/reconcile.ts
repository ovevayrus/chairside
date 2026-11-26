import { isOurs } from '../calendar/adapter.js'
import { bookingFor, type BookingRow } from '../db/bookings.js'
import type { RequestRow } from '../db/requests.js'
import { proposal, type Proposal } from '../requests/cards.js'
import { calendarFailed, plannedBooking, verifyAndRecord } from './booking.js'
import {
  cleanupForMove,
  cleanupMovedEvent,
  recordCancellation,
} from './changes.js'
import {
  finish,
  replaceCard,
  taken,
  type ActionContext,
  type ActionRow,
} from './context.js'
import { reopenAcceptance } from './offers.js'
import { recoveryCard, unknownReply } from './send.js'

function abandonReceived(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
) {
  const { store } = ctx
  store.transaction(() => {
    const visible =
      row.version === action.version &&
      store.pending(row.chat_id).some((r) => r.id === row.id)
    let card
    if (visible) {
      // These proposals had no external side effects. Give the owner new keys
      // for a deliberate new tap, keeping the interrupted command terminal.
      const fresh = store
        .proposals(row)
        .map((p) =>
          proposal(
            p.kind,
            p.label,
            p.slot_start_utc && p.slot_end_utc
              ? { startUtc: p.slot_start_utc, endUtc: p.slot_end_utc }
              : undefined,
          ),
        )
      if (fresh.length) card = replaceCard(ctx, row, row.status, fresh)
    }
    finish(
      ctx,
      action,
      {
        status: 'error',
        card,
        receipt: 'Action interrupted before completion',
      },
      'failed',
    )
  })
}

async function recoverCalendar(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
) {
  const { store, calendar } = ctx
  const input = plannedBooking(ctx, action, row, p)
  if (!input || !action.planned_event_id)
    throw new Error('Incomplete calendar intent')
  const moving = p.kind === 'move' || p.kind === 'move_offer_accepted'
  const previous = moving ? bookingFor(store, row.booking_id) : undefined
  if (moving && !previous) throw new Error('Missing original booking')
  // A committed move has already verified the new event. The old event may
  // have been deleted, and a failed cleanup has its own durable retry marker.
  if (moving && bookingFor(store, action.id)) {
    recoverReply(ctx, action, row, p, 'Moved')
    return
  }
  let event
  try {
    event = await calendar.getEvent(input.id)
  } catch {
    // Google has not established absence. Preserve the intent for a later
    // reconciliation and keep the request closed to other actions.
    return
  }
  if (!event) {
    store.transaction(() => {
      store.db.prepare('DELETE FROM bookings WHERE id=?').run(action.id)
      calendarFailed(
        ctx,
        action,
        row,
        moving
          ? 'New slot missing · No reply sent'
          : 'Booking missing · No reply sent',
      )
    })
    return
  }
  if (!isOurs(event, input) || event.id !== input.id) {
    store.db.prepare('DELETE FROM bookings WHERE id=?').run(action.id)
    await taken(ctx, action, row, p)
    return
  }
  if (await verifyAndRecord(ctx, action, row, p, input, previous)) return
  if (moving) await cleanupForMove(ctx, row)
  recoverReply(ctx, action, row, p, moving ? 'Moved' : 'Booked')
}

function recoverReply(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
  result: 'Booked' | 'Moved' | 'Cancelled',
) {
  const { store } = ctx
  store.transaction(() => {
    if (result !== 'Cancelled')
      store.db
        .prepare("UPDATE bookings SET reply_status='reply_not_sent' WHERE id=?")
        .run(action.id)
    const card = recoveryCard(ctx, row, p, 'Send now')
    const cleanup =
      result === 'Moved' && bookingFor(store, row.booking_id)?.cleanup_pending
    finish(
      ctx,
      action,
      {
        status: 'ok',
        card,
        receipt: `${result}, reply not sent · Send now?${cleanup ? ' · old slot still on calendar' : ''}`,
      },
      'reply_not_sent',
    )
  })
}

/** Startup finishes calendar effects and leaves unsent replies to the owner. */
export function reconcile(ctx: ActionContext): Promise<void> {
  const { store } = ctx
  return store.withLock(async () => {
    const cleanup = store.db
      .prepare(
        "SELECT * FROM bookings WHERE shop_id=? AND status='moved' AND cleanup_pending=1",
      )
      .all(store.shopId) as unknown as BookingRow[]
    for (const booking of cleanup) await cleanupMovedEvent(ctx, booking)

    const interrupted = store.db
      .prepare(
        `SELECT a.* FROM actions a
      JOIN requests r ON a.request_id = r.id WHERE r.shop_id=?
      AND a.state IN ('received','calendar_pending','cancel_pending','send_started') ORDER BY a.rowid`,
      )
      .all(store.shopId) as unknown as ActionRow[]
    for (const action of interrupted) {
      const row = store.get(action.request_id)!
      const p = store
        .proposals({ ...row, version: action.version })
        .find((p) => p.id === action.action_id)
      if (action.state === 'received') {
        // An acceptance has no visible card to restore: show the owner its slot.
        if (p && action.idempotency_key.startsWith('offer:'))
          await reopenAcceptance(ctx, action, row, p)
        else abandonReceived(ctx, action, row)
        continue
      }
      if (!p) throw new Error('Missing persisted action proposal')
      if (action.state === 'send_started') {
        unknownReply(ctx, action, row, p)
      } else if (action.state === 'cancel_pending') {
        const booking = bookingFor(store, row.booking_id)
        if (!booking) throw new Error('Missing cancellation booking')
        if (!(await recordCancellation(ctx, action, booking)))
          recoverReply(ctx, action, row, p, 'Cancelled')
      } else {
        await recoverCalendar(ctx, action, row, p)
      }
    }
  })
}
