export interface CalEvent {
  id: string
  startUtc: string
  endUtc: string
  summary: string
  privateProps: Record<string, string>
  transparent?: boolean
  etag?: string
}

export type FreeBusyResult =
  | { ok: true; busy: Array<{ startUtc: string; endUtc: string }> }
  | { ok: false; reason: string }

export type InsertResult =
  | { status: 'created' | 'already_ours'; event: CalEvent }
  | { status: 'conflict'; existing?: CalEvent }

export interface InsertInput {
  id: string
  startUtc: string
  endUtc: string
  summary: string
  privateProps: Record<string, string>
}

export interface CalendarOwnership {
  id: string
  bookingId: string
  startUtc: string
  endUtc: string
}

export interface CalendarAdapter {
  freeBusy(rangeStartUtc: string, rangeEndUtc: string): Promise<FreeBusyResult>
  insertEvent(input: InsertInput): Promise<InsertResult>
  getEvent(id: string): Promise<CalEvent | null>
  deleteEvent(id: string, etag?: string): Promise<void>
  listEvents(rangeStartUtc: string, rangeEndUtc: string): Promise<CalEvent[]>
}

export function sameInterval(
  a: { startUtc: string; endUtc: string },
  b: { startUtc: string; endUtc: string },
): boolean {
  return (
    Date.parse(a.startUtc) === Date.parse(b.startUtc) &&
    Date.parse(a.endUtc) === Date.parse(b.endUtc)
  )
}

/** An existing event counts as ours only with the booking marker and the exact interval. */
export function isOurs(existing: CalEvent, input: InsertInput): boolean {
  const marker = existing.privateProps.chairsideBookingId
  return (
    Boolean(marker) &&
    marker === input.privateProps.chairsideBookingId &&
    sameInterval(existing, input)
  )
}

export function matchesBooking(
  event: CalEvent,
  booking: CalendarOwnership,
): boolean {
  return (
    event.id === booking.id &&
    event.privateProps.chairsideBookingId === booking.bookingId &&
    sameInterval(event, booking)
  )
}

/** freeBusy intervals have no event IDs and may combine separate events. */
export async function freeBusyExcluding(
  calendar: CalendarAdapter,
  rangeStartUtc: string,
  rangeEndUtc: string,
  ownership: CalendarOwnership,
): Promise<FreeBusyResult> {
  try {
    const events = await calendar.listEvents(rangeStartUtc, rangeEndUtc)
    if (
      events.some(
        ({ startUtc, endUtc }) => !(Date.parse(endUtc) > Date.parse(startUtc)),
      )
    )
      return { ok: false, reason: 'Calendar returned an invalid interval' }
    return {
      ok: true,
      busy: events
        .filter(
          (event) => !event.transparent && !matchesBooking(event, ownership),
        )
        .map(({ startUtc, endUtc }) => ({ startUtc, endUtc })),
    }
  } catch {
    return { ok: false, reason: 'Calendar unavailable' }
  }
}
