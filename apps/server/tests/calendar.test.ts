import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eventIdFor } from '../src/calendar/eventId.js'
import { FakeCalendar } from '../src/calendar/fake.js'
import { GoogleCalendarAdapter } from '../src/calendar/google.js'

const CAL_ID = 'shop-calendar@group.calendar.google.com'
const API = 'https://www.googleapis.com/calendar/v3'
const START = '2030-01-10T06:00:00.000Z'
const END = '2030-01-10T06:45:00.000Z'

describe('eventIdFor', () => {
  it('uses only a-v and 0-9 and is 26 characters', () => {
    for (let i = 0; i < 50; i++) {
      const id = eventIdFor('shop', `req-${i}`, START)
      expect(id).toMatch(/^[0-9a-v]{26}$/)
    }
  })

  it('is stable for equal inputs and differs across slots', () => {
    const a = eventIdFor('shop', 'req', START)
    expect(eventIdFor('shop', 'req', START)).toBe(a)
    expect(eventIdFor('shop', 'req', '2030-01-10T07:00:00.000Z')).not.toBe(a)
    expect(eventIdFor('shop', 'other', START)).not.toBe(a)
    expect(eventIdFor('other', 'req', START)).not.toBe(a)
  })
})

describe('GoogleCalendarAdapter', () => {
  const server = setupServer()
  let dir: string
  let keyPath: string
  let adapter: GoogleCalendarAdapter

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' })
    dir = mkdtempSync(join(tmpdir(), 'chairside-cal-'))
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    keyPath = join(dir, 'sa.json')
    writeFileSync(
      keyPath,
      JSON.stringify({
        type: 'service_account',
        client_email: 'test@example.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    )
  })
  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  afterEach(() => server.resetHandlers())

  const useToken = () =>
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({
          access_token: 'test-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      ),
    )
  const make = () => {
    useToken()
    adapter = new GoogleCalendarAdapter({
      serviceAccountJsonPath: keyPath,
      calendarId: CAL_ID,
    })
    return adapter
  }
  const freeBusy = (body: unknown, status = 200) =>
    server.use(
      http.post(`${API}/freeBusy`, () => HttpResponse.json(body, { status })),
    )
  const eventBody = (over: Record<string, unknown> = {}) => ({
    id: 'evt',
    status: 'confirmed',
    summary: 'Chairside · Omar · Haircut',
    start: { dateTime: START },
    end: { dateTime: END },
    extendedProperties: { private: { chairsideBookingId: 'b1' } },
    ...over,
  })
  const input = {
    id: 'evt',
    startUtc: START,
    endUtc: END,
    summary: 'Chairside · Omar · Haircut',
    privateProps: { chairsideBookingId: 'b1', requestId: 'r1' },
  }
  const conflictThenGet = (existing: Record<string, unknown>) =>
    server.use(
      http.post(`${API}/calendars/:cal/events`, () =>
        HttpResponse.json(
          { error: { code: 409, message: 'exists' } },
          { status: 409 },
        ),
      ),
      http.get(`${API}/calendars/:cal/events/evt`, () =>
        HttpResponse.json(existing),
      ),
    )

  it('returns busy intervals from freeBusy', async () => {
    freeBusy({
      calendars: { [CAL_ID]: { busy: [{ start: START, end: END }] } },
    })
    expect(await make().freeBusy(START, END)).toEqual({
      ok: true,
      busy: [{ startUtc: START, endUtc: END }],
    })
  })

  it('fails closed on a freeBusy HTTP error', async () => {
    freeBusy({ error: { code: 500, message: 'boom' } }, 500)
    const result = await make().freeBusy(START, END)
    expect(result.ok).toBe(false)
  })

  it('fails closed on a freeBusy 200 with a calendar-level errors entry', async () => {
    freeBusy({
      calendars: {
        [CAL_ID]: {
          errors: [{ domain: 'global', reason: 'notFound' }],
          busy: [],
        },
      },
    })
    const result = await make().freeBusy(START, END)
    expect(result.ok).toBe(false)
  })

  it('creates an event with the id and private properties', async () => {
    let sent: Record<string, unknown> = {}
    server.use(
      http.post(`${API}/calendars/:cal/events`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(eventBody())
      }),
    )
    const result = await make().insertEvent(input)
    expect(result.status).toBe('created')
    expect(sent.id).toBe('evt')
    expect(sent.extendedProperties).toEqual({ private: input.privateProps })
  })

  it('treats a 409 with the matching marker and interval as ours', async () => {
    conflictThenGet(eventBody())
    const result = await make().insertEvent(input)
    expect(result.status).toBe('already_ours')
  })

  it('treats a 409 with a foreign event as a conflict', async () => {
    conflictThenGet(
      eventBody({
        extendedProperties: { private: { chairsideBookingId: 'x' } },
      }),
    )
    expect((await make().insertEvent(input)).status).toBe('conflict')
  })

  it('treats a 409 with the marker but a different interval as a conflict', async () => {
    conflictThenGet(
      eventBody({ end: { dateTime: '2030-01-10T07:00:00.000Z' } }),
    )
    expect((await make().insertEvent(input)).status).toBe('conflict')
  })

  it('treats a 409 for a cancelled event with the same id as a conflict', async () => {
    conflictThenGet(eventBody({ status: 'cancelled' }))
    expect((await make().insertEvent(input)).status).toBe('conflict')
  })

  it('does not retry an insert that returns 503', async () => {
    let calls = 0
    server.use(
      http.post(`${API}/calendars/:cal/events`, () => {
        calls++
        return HttpResponse.json({ error: { code: 503 } }, { status: 503 })
      }),
    )
    await expect(make().insertEvent(input)).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('lists events with singleEvents and orderBy, skipping cancelled ones', async () => {
    let url = new URL('https://x.invalid')
    server.use(
      http.get(`${API}/calendars/:cal/events`, ({ request }) => {
        url = new URL(request.url)
        return HttpResponse.json({
          items: [eventBody(), eventBody({ id: 'gone', status: 'cancelled' })],
        })
      }),
    )
    const events = await make().listEvents(START, END)
    expect(events.map((e) => e.id)).toEqual(['evt'])
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
  })

  it('getEvent returns null for 404 and deleteEvent tolerates 404', async () => {
    server.use(
      http.get(`${API}/calendars/:cal/events/:id`, () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
      http.delete(`${API}/calendars/:cal/events/:id`, () =>
        HttpResponse.json({ error: { code: 404 } }, { status: 404 }),
      ),
    )
    const a = make()
    expect(await a.getEvent('evt')).toBeNull()
    await expect(a.deleteEvent('evt')).resolves.toBeUndefined()
  })
})

describe('FakeCalendar', () => {
  it('returns already_ours for the same marker and interval, conflict for a foreign event', async () => {
    const cal = new FakeCalendar()
    const input = {
      id: 'evt',
      startUtc: START,
      endUtc: END,
      summary: 's',
      privateProps: { chairsideBookingId: 'b1' },
    }
    expect((await cal.insertEvent(input)).status).toBe('created')
    expect((await cal.insertEvent(input)).status).toBe('already_ours')
    const foreign = cal.addForeignEvent({
      id: 'f1',
      startUtc: START,
      endUtc: END,
    })
    expect((await cal.insertEvent({ ...input, id: foreign.id })).status).toBe(
      'conflict',
    )
  })

  it('remembers deleted ids as conflicts', async () => {
    const cal = new FakeCalendar()
    const input = {
      id: 'evt',
      startUtc: START,
      endUtc: END,
      summary: 's',
      privateProps: { chairsideBookingId: 'b1' },
    }
    await cal.insertEvent(input)
    await cal.deleteEvent('evt')
    expect(await cal.getEvent('evt')).toBeNull()
    expect((await cal.insertEvent(input)).status).toBe('conflict')
  })

  it('fails closed on injected freeBusy errors and throws on insert 5xx', async () => {
    const cal = new FakeCalendar()
    cal.failures.freeBusyError = true
    expect((await cal.freeBusy(START, END)).ok).toBe(false)
    cal.failures.freeBusyError = false
    cal.failures.calendarLevelError = true
    expect((await cal.freeBusy(START, END)).ok).toBe(false)
    cal.failures.insert5xx = true
    await expect(
      cal.insertEvent({
        id: 'e',
        startUtc: START,
        endUtc: END,
        summary: 's',
        privateProps: {},
      }),
    ).rejects.toThrow()
  })

  it('reports busy intervals from stored events', async () => {
    const cal = new FakeCalendar()
    cal.addForeignEvent({ startUtc: START, endUtc: END })
    expect(await cal.freeBusy(START, END)).toEqual({
      ok: true,
      busy: [{ startUtc: START, endUtc: END }],
    })
  })
})
