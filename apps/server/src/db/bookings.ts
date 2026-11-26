import type { CalendarOwnership } from '../calendar/adapter.js'
import type { RequestStore } from './requests.js'

export interface BookingRow {
  id: string
  shop_id: string
  request_id: string
  calendar_event_id: string
  slot_start_utc: string
  slot_end_utc: string
  reply_status: string
  status: 'active' | 'moved' | 'cancelled'
  service_id: string | null
  replaced_booking_id: string | null
  cleanup_pending: number
  pending_action_id: string | null
}

export function bookingFor(
  store: RequestStore,
  bookingId: string | null,
): BookingRow | undefined {
  if (!bookingId) return
  return store.db
    .prepare('SELECT * FROM bookings WHERE shop_id=? AND id=?')
    .get(store.shopId, bookingId) as unknown as BookingRow | undefined
}

export function upcomingBookings(
  store: RequestStore,
  chatId: number,
): BookingRow[] {
  return store.db
    .prepare(
      `SELECT b.* FROM bookings b JOIN requests r ON r.id=b.request_id
      WHERE b.shop_id=? AND r.chat_id=? AND b.status='active' AND b.reply_status='sent'
      AND b.slot_start_utc>? ORDER BY b.slot_start_utc, b.rowid`,
    )
    .all(
      store.shopId,
      chatId,
      store.now().toISOString(),
    ) as unknown as BookingRow[]
}

export function bookingEvent(booking: BookingRow): CalendarOwnership {
  return {
    id: booking.calendar_event_id,
    bookingId: booking.id,
    startUtc: booking.slot_start_utc,
    endUtc: booking.slot_end_utc,
  }
}

export function releaseBookingChange(
  store: RequestStore,
  bookingId: string | null,
  actionId: string,
): void {
  if (!bookingId) return
  store.db
    .prepare(
      'UPDATE bookings SET pending_action_id=NULL WHERE shop_id=? AND id=? AND pending_action_id=?',
    )
    .run(store.shopId, bookingId, actionId)
}
