import {
  isOurs,
  type CalEvent,
  type CalendarAdapter,
  type FreeBusyResult,
  type InsertInput,
  type InsertResult,
} from './adapter.js'

export interface FakeCalendarFailures {
  /** freeBusy fails closed as an HTTP error would. */
  freeBusyError?: boolean
  /** freeBusy fails closed as a calendar-level `errors` entry would. */
  calendarLevelError?: boolean
  /** insertEvent throws as a 5xx would. */
  insert5xx?: boolean
}

const iso = (value: string): string => new Date(value).toISOString()

export class FakeCalendar implements CalendarAdapter {
  readonly failures: FakeCalendarFailures = {}
  private readonly events = new Map<string, CalEvent>()
  private readonly deleted = new Set<string>()

  async freeBusy(
    rangeStartUtc: string,
    rangeEndUtc: string,
  ): Promise<FreeBusyResult> {
    if (this.failures.freeBusyError) {
      return { ok: false, reason: 'fake freeBusy HTTP error' }
    }
    if (this.failures.calendarLevelError) {
      return { ok: false, reason: 'fake calendar-level error' }
    }
    return {
      ok: true,
      busy: (await this.listEvents(rangeStartUtc, rangeEndUtc)).map((e) => ({
        startUtc: e.startUtc,
        endUtc: e.endUtc,
      })),
    }
  }

  async insertEvent(input: InsertInput): Promise<InsertResult> {
    if (this.failures.insert5xx) throw new Error('fake insert 5xx')
    // Google keeps deleted ids, so a re-insert of a deleted id is a conflict.
    if (this.deleted.has(input.id)) return { status: 'conflict' }
    const existing = this.events.get(input.id)
    if (existing) {
      return isOurs(existing, input)
        ? { status: 'already_ours', event: { ...existing } }
        : { status: 'conflict', existing: { ...existing } }
    }
    const event: CalEvent = {
      id: input.id,
      startUtc: iso(input.startUtc),
      endUtc: iso(input.endUtc),
      summary: input.summary,
      privateProps: { ...input.privateProps },
    }
    this.events.set(event.id, event)
    return { status: 'created', event: { ...event } }
  }

  async getEvent(id: string): Promise<CalEvent | null> {
    const event = this.events.get(id)
    return event ? { ...event } : null
  }

  async deleteEvent(id: string): Promise<void> {
    if (this.events.delete(id)) this.deleted.add(id)
  }

  async listEvents(
    rangeStartUtc: string,
    rangeEndUtc: string,
  ): Promise<CalEvent[]> {
    const from = Date.parse(rangeStartUtc)
    const to = Date.parse(rangeEndUtc)
    return [...this.events.values()]
      .filter((e) => Date.parse(e.startUtc) < to && Date.parse(e.endUtc) > from)
      .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
      .map((e) => ({ ...e }))
  }

  /** Test hook: an event created by someone else (no booking marker). */
  addForeignEvent(
    event: Partial<CalEvent> & { startUtc: string; endUtc: string },
  ): CalEvent {
    const full: CalEvent = {
      id: event.id ?? `foreign${this.events.size}`,
      startUtc: iso(event.startUtc),
      endUtc: iso(event.endUtc),
      summary: event.summary ?? 'Busy',
      privateProps: event.privateProps ?? {},
    }
    this.events.set(full.id, full)
    return full
  }
}
