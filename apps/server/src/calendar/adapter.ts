export interface CalEvent {
  id: string
  startUtc: string
  endUtc: string
  summary: string
  privateProps: Record<string, string>
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

export interface CalendarAdapter {
  freeBusy(rangeStartUtc: string, rangeEndUtc: string): Promise<FreeBusyResult>
  insertEvent(input: InsertInput): Promise<InsertResult>
  getEvent(id: string): Promise<CalEvent | null>
  deleteEvent(id: string): Promise<void>
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
