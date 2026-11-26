import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  calendar as createCalendar,
  type calendar_v3,
} from '@googleapis/calendar'
import { JWT } from 'google-auth-library'
import { DateTime } from 'luxon'
import {
  isOurs,
  type CalEvent,
  type CalendarAdapter,
  type FreeBusyResult,
  type InsertInput,
  type InsertResult,
} from './adapter.js'

const SCOPE = 'https://www.googleapis.com/auth/calendar'
const TIMEOUT_MS = 10_000
const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export interface GoogleCalendarOptions {
  /** Path to the service-account JSON; relative paths resolve against apps/server. */
  serviceAccountJsonPath: string
  calendarId: string
}

export function googleCalendarFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleCalendarAdapter {
  const serviceAccountJsonPath = env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  const calendarId = env.GOOGLE_CALENDAR_ID
  if (!serviceAccountJsonPath || !calendarId) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON_PATH and GOOGLE_CALENDAR_ID must be set',
    )
  }
  return new GoogleCalendarAdapter({ serviceAccountJsonPath, calendarId })
}

function statusOf(error: unknown): number | undefined {
  const e = error as {
    status?: unknown
    code?: unknown
    response?: { status?: unknown }
  } | null
  const value = e?.response?.status ?? e?.status ?? e?.code
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private readonly calendar: calendar_v3.Calendar
  private readonly calendarId: string

  constructor(options: GoogleCalendarOptions) {
    const path = resolve(SERVER_ROOT, options.serviceAccountJsonPath)
    const key = JSON.parse(readFileSync(path, 'utf8')) as {
      client_email: string
      private_key: string
    }
    const auth = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [SCOPE],
    })
    this.calendar = createCalendar({ version: 'v3', auth })
    this.calendarId = options.calendarId
  }

  // 10 s timeout, never retry (inserts must not be replayed automatically).
  private opts() {
    return { timeout: TIMEOUT_MS, retry: false } as const
  }

  async freeBusy(
    rangeStartUtc: string,
    rangeEndUtc: string,
  ): Promise<FreeBusyResult> {
    try {
      const res = await this.calendar.freebusy.query(
        {
          requestBody: {
            timeMin: new Date(rangeStartUtc).toISOString(),
            timeMax: new Date(rangeEndUtc).toISOString(),
            items: [{ id: this.calendarId }],
          },
        },
        this.opts(),
      )
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, reason: `freeBusy HTTP ${res.status}` }
      }
      const entry = res.data.calendars?.[this.calendarId]
      if (!entry) return { ok: false, reason: 'freeBusy: calendar missing' }
      if (entry.errors && entry.errors.length > 0) {
        return {
          ok: false,
          reason: `freeBusy calendar error: ${entry.errors[0]?.reason ?? 'unknown'}`,
        }
      }
      const busy: Array<{ startUtc: string; endUtc: string }> = []
      for (const b of entry.busy ?? []) {
        if (!b.start || !b.end) {
          return { ok: false, reason: 'freeBusy: malformed busy entry' }
        }
        busy.push({
          startUtc: new Date(b.start).toISOString(),
          endUtc: new Date(b.end).toISOString(),
        })
      }
      return { ok: true, busy }
    } catch (error) {
      return { ok: false, reason: `freeBusy failed: ${messageOf(error)}` }
    }
  }

  async insertEvent(input: InsertInput): Promise<InsertResult> {
    try {
      const res = await this.calendar.events.insert(
        {
          calendarId: this.calendarId,
          requestBody: {
            id: input.id,
            summary: input.summary,
            start: { dateTime: new Date(input.startUtc).toISOString() },
            end: { dateTime: new Date(input.endUtc).toISOString() },
            extendedProperties: { private: input.privateProps },
          },
        },
        this.opts(),
      )
      const event = toCalEvent(res.data)
      if (!event) throw new Error('insert returned an unusable event')
      return { status: 'created', event }
    } catch (error) {
      if (statusOf(error) !== 409) throw error
    }
    // 409: the id exists. Ours only if marker and interval match and it is not cancelled.
    const raw = await this.fetchRaw(input.id)
    if (!raw || raw.status === 'cancelled') return { status: 'conflict' }
    const existing = toCalEvent(raw)
    if (!existing) return { status: 'conflict' }
    return isOurs(existing, input)
      ? { status: 'already_ours', event: existing }
      : { status: 'conflict', existing }
  }

  async getEvent(id: string): Promise<CalEvent | null> {
    const raw = await this.fetchRaw(id)
    if (!raw || raw.status === 'cancelled') return null
    return toCalEvent(raw)
  }

  async deleteEvent(id: string, etag?: string): Promise<void> {
    try {
      await this.calendar.events.delete(
        { calendarId: this.calendarId, eventId: id },
        { ...this.opts(), ...(etag && { headers: { 'If-Match': etag } }) },
      )
    } catch (error) {
      const status = statusOf(error)
      if (status === 404 || status === 410) return
      throw error
    }
  }

  async listEvents(
    rangeStartUtc: string,
    rangeEndUtc: string,
  ): Promise<CalEvent[]> {
    const out: CalEvent[] = []
    let pageToken: string | undefined
    do {
      const res: { data: calendar_v3.Schema$Events } =
        await this.calendar.events.list(
          {
            calendarId: this.calendarId,
            timeMin: new Date(rangeStartUtc).toISOString(),
            timeMax: new Date(rangeEndUtc).toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            showDeleted: false,
            pageToken,
          },
          this.opts(),
        )
      for (const item of res.data.items ?? []) {
        if (item.status === 'cancelled') continue
        const event = toCalEvent(item, res.data.timeZone ?? undefined)
        if (!event) throw new Error('Calendar returned an unusable event')
        out.push(event)
      }
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
    return out
  }

  private async fetchRaw(id: string): Promise<calendar_v3.Schema$Event | null> {
    try {
      const res = await this.calendar.events.get(
        { calendarId: this.calendarId, eventId: id },
        this.opts(),
      )
      return res.data
    } catch (error) {
      const status = statusOf(error)
      if (status === 404 || status === 410) return null
      throw error
    }
  }
}

function toCalEvent(
  raw: calendar_v3.Schema$Event,
  calendarZone = 'UTC',
): CalEvent | null {
  function toUtc(value: calendar_v3.Schema$EventDateTime | undefined) {
    const text = value?.dateTime ?? value?.date
    return text
      ? DateTime.fromISO(text, { zone: value?.timeZone ?? calendarZone })
          .toUTC()
          .toISO()
      : null
  }
  const start = toUtc(raw.start)
  const end = toUtc(raw.end)
  if (!raw.id || !start || !end) return null
  return {
    id: raw.id,
    startUtc: start,
    endUtc: end,
    summary: raw.summary ?? '',
    privateProps: { ...(raw.extendedProperties?.private ?? {}) },
    ...(raw.transparency === 'transparent' && { transparent: true }),
    ...(raw.etag && { etag: raw.etag }),
  }
}
