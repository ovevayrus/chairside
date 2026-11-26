import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { textSha256 } from '../src/telegram/fake.js'
import {
  bookingFixture,
  connectionId,
  customerId,
  tap,
  tenant,
} from './booking-fixture.js'

const saturday = '2026-12-05'
const time = (utc: string) => `${saturday}T${utc}:00.000Z`
const lateText = 'running 15 min late'
const shift = 'Shift to 15:15 & reply'
const shifted = { startUtc: time('11:15'), endUtc: time('12:00') }

async function confirmedBooking(
  options?: Parameters<typeof bookingFixture>[0],
  at = '15:00',
  now = time('10:30'),
) {
  const f = await bookingFixture(options)
  const card = await f.cardFor(
    `Haircut on Saturday 5 Dec at ${at}`,
    customerId,
    'Alex',
  )
  expect((await f.runtime.execute(tap(card))).status).toBe('ok')
  f.advance(Date.parse(now) - f.now().getTime())
  return f
}

type Fixture = Awaited<ReturnType<typeof confirmedBooking>>

function lateCard(f: Fixture, text = lateText) {
  return f.cardFor(text, customerId, 'Alex')
}

async function addJames(f: Fixture, starts: string, ends: string) {
  const result = await f.calendar.insertEvent({
    id: 'james-event',
    startUtc: time(starts),
    endUtc: time(ends),
    summary: 'Chairside · James Smith · Haircut',
    privateProps: { chairsideBookingId: 'james-booking', requestId: 'james' },
  })
  if (result.status !== 'created') throw new Error('Could not seed James')
  return result.event
}

it('shows that an off-grid shift fits when the buffer ends at the next appointment', async () => {
  const f = await confirmedBooking()
  await addJames(f, '12:00', '12:45')
  const card = await lateCard(f, 'Sorry, 10 minutes late')
  expect(card).toMatchObject({
    header: 'RUNNING LATE',
    lines: [
      'Alex · Haircut 15:00',
      '10 min late ▶ starts 15:10',
      'Next: James 16:00 · fits',
    ],
  })
  expect(card.actions.map(({ label }) => label)).toEqual([
    'Shift to 15:10 & reply',
    'Not now',
  ])
})

it('shows an arrival before the booking as an ordinary message without a shift action', async () => {
  const f = await confirmedBooking()
  const before = await f.events()
  const card = await lateCard(f, 'be there in 20')

  expect(f.runtime.store.get(card.requestId)?.intent).toBe('unknown')
  expect(card.header).toBe('NEEDS YOU')
  expect(card.actions.map(({ label }) => label)).toEqual(['Not now'])
  expect(await f.events()).toEqual(before)
})

it('shows nothing after when there is only an event on another day', async () => {
  const f = await confirmedBooking()
  f.calendar.addForeignEvent({
    startUtc: '2026-12-06T12:00:00.000Z',
    endUtc: '2026-12-06T12:45:00.000Z',
  })
  expect(await lateCard(f)).toMatchObject({
    header: 'RUNNING LATE',
    lines: [
      'Alex · Haircut 15:00',
      '15 min late ▶ starts 15:15',
      'Nothing after · fits',
    ],
  })
})

it('shows busy for a foreign event even if its summary resembles Chairside’s', async () => {
  const f = await confirmedBooking()
  f.calendar.addForeignEvent({
    startUtc: time('12:15'),
    endUtc: time('12:45'),
    summary: 'Chairside · Sensitive Name · Private Meeting',
  })
  const card = await lateCard(f)
  expect(card.lines.at(-1)).toBe('Next: busy 16:15 · fits')
  expect(JSON.stringify(card)).not.toMatch(/Sensitive|Private Meeting/)
})

it('reports closing time only when the shifted appointment ends after closing', async () => {
  const f = await confirmedBooking(undefined, '19:00')
  expect((await lateCard(f)).lines.at(-1)).toBe('Nothing after · fits')
  const card = await lateCard(f, 'running 20 min late')
  expect(card.lines.at(-1)).toMatch(/clos/i)
  expect(card.actions.map(({ label }) => label)).toEqual([
    'Offer Mon 7 Dec 10:00',
    'Not now',
  ])
})

it('creates the replacement before removing the current booking and replays without another send', async () => {
  const f = await confirmedBooking(undefined, '15:00', time('11:02'))
  const [original] = await f.events()
  const shiftedOffGrid = { startUtc: time('11:10'), endUtc: time('11:55') }
  const input = tap(
    await lateCard(f, "can't be there till 3:10"),
    'Shift to 15:10 & reply',
  )
  const remove = f.calendar.deleteEvent.bind(f.calendar)
  const deleteEvent = vi
    .spyOn(f.calendar, 'deleteEvent')
    .mockImplementation(async (id, etag) => {
      expect(id).toBe(original!.id)
      expect(await f.events()).toEqual([
        original,
        expect.objectContaining(shiftedOffGrid),
      ])
      expect(f.sends()).toHaveLength(1)
      await remove(id, etag)
    })

  const result = await f.postAction(input)
  expect(result).toEqual({
    http: 200,
    body: { status: 'ok', receipt: '● Shifted to 15:10' },
  })
  for (const idempotencyKey of [input.idempotencyKey, randomUUID()]) {
    expect(await f.postAction({ ...input, idempotencyKey })).toEqual({
      ...result,
      body: { ...result.body, idempotencyKey: input.idempotencyKey },
    })
  }
  expect(deleteEvent).toHaveBeenCalledOnce()
  expect(await f.events()).toEqual([expect.objectContaining(shiftedOffGrid)])
  expect(f.bookings()).toEqual([
    expect.objectContaining({
      status: 'moved',
      calendar_event_id: original!.id,
    }),
    expect.objectContaining({
      status: 'active',
      replaced_booking_id: original!.privateProps.chairsideBookingId,
      reply_status: 'sent',
    }),
  ])
  expect(f.sends().slice(1)).toEqual([
    expect.objectContaining({
      chatId: customerId,
      connectionId,
      textSha256: textSha256('No problem, Alex! See you at 15:10.'),
    }),
  ])
})

it('keeps the original booking and offers the next opening when the shift is taken at the press', async () => {
  const f = await confirmedBooking()
  const [original] = await f.events()
  const input = tap(await lateCard(f), shift)
  const intervening = f.calendar.addForeignEvent({
    startUtc: time('12:00'),
    endUtc: time('12:30'),
  })
  const insert = vi.spyOn(f.calendar, 'insertEvent')
  const response = await f.runtime.execute(input)
  expect(response.status).toBe('slot_taken')
  expect(response.card).toMatchObject({
    requestId: input.requestId,
    header: 'RUNNING LATE',
    lines: [
      'Alex · Haircut 15:00',
      '15 min late ▶ starts 15:15',
      'Next: busy 16:00 · 5 min over',
    ],
  })
  expect(response.card!.version).toBeGreaterThan(input.version)
  expect(response.card!.actions.map(({ label }) => label)).toEqual([
    'Offer Sat 5 Dec 16:45',
    'Not now',
  ])
  expect(insert).not.toHaveBeenCalled()
  expect(await f.events()).toEqual([original, intervening])
  expect(f.bookings()).toEqual([expect.objectContaining({ status: 'active' })])
  expect(f.sends()).toHaveLength(1)
})

it('shows the overlap including buffer, then moves the existing booking when the customer says yes', async () => {
  const f = await confirmedBooking()
  const [original] = await f.events()
  const james = await addJames(f, '11:55', '12:40')
  const card = await lateCard(f)
  expect(card.lines).toEqual([
    'Alex · Haircut 15:00',
    '15 min late ▶ starts 15:15',
    'Next: James 15:55 · 10 min over',
  ])
  expect(card.actions.map(({ label }) => label)).toEqual([
    'Offer Sat 5 Dec 16:45',
    'Not now',
  ])
  expect(await f.runtime.execute(tap(card, 'Offer Sat 5 Dec 16:45'))).toEqual({
    status: 'ok',
    receipt: '● Offered Sat 5 Dec 16:45',
  })
  expect(await f.events()).toEqual([original, james])
  expect(f.sends()).toHaveLength(2)

  await f.receive('yes', customerId, 'Alex')
  await vi.waitFor(() => expect(f.sends()).toHaveLength(3))
  expect(await f.events()).toEqual([
    james,
    expect.objectContaining({ startUtc: time('12:45'), endUtc: time('13:30') }),
  ])
  expect(f.bookings()).toEqual([
    expect.objectContaining({
      status: 'moved',
      calendar_event_id: original!.id,
    }),
    expect.objectContaining({
      status: 'active',
      replaced_booking_id: original!.privateProps.chairsideBookingId,
    }),
  ])
  expect(f.sends().at(-1)).toMatchObject({
    chatId: customerId,
    textSha256: textSha256(
      'Done! Your Haircut is now on Saturday 5 Dec at 16:45, Alex.',
    ),
  })
})

it('uses the move fallback when there is no later opening to offer', async () => {
  const f = await confirmedBooking()
  f.calendar.addForeignEvent({
    startUtc: time('12:00'),
    endUtc: '2026-12-15T12:00:00.000Z',
  })
  const card = await lateCard(f)
  expect(card.lines.at(-1)).toBe('Next: busy 16:00 · 5 min over')
  expect(card.actions.map(({ label }) => label)).toEqual([
    'Ask for another time',
    'Not now',
  ])
})

it('asks how late with no time given and leaves the calendar unchanged', async () => {
  const f = await confirmedBooking()
  const before = await f.events()
  const card = await lateCard(f, "I'm running late")
  expect(card).toMatchObject({
    header: 'RUNNING LATE',
    lines: ['Alex · Haircut 15:00', 'Late · no time given'],
  })
  expect(card.actions.map(({ label }) => label)).toEqual([
    'Ask how late',
    'Not now',
  ])
  expect(await f.runtime.execute(tap(card, 'Ask how late'))).toMatchObject({
    status: 'ok',
    receipt: expect.any(String),
  })
  expect(await f.events()).toEqual(before)
  expect(f.sends().slice(1)).toEqual([
    expect.objectContaining({
      chatId: customerId,
      connectionId,
      textSha256: textSha256(
        'No problem, Alex. Roughly what time will you get here?',
      ),
    }),
  ])
})

it('leaves a late report with the owner when the chat has no unended booking today', async () => {
  const f = await confirmedBooking(undefined, '15:00', '2026-12-04T10:30:00Z')
  const before = await f.events()
  for (const now of [f.now().getTime(), Date.parse(time('11:45'))]) {
    f.advance(now - f.now().getTime())
    const card = await lateCard(f, "can't be there till 3:20")
    expect(card.header).toBe('NEEDS YOU')
    expect(card.actions.map(({ label }) => label)).toEqual(['Not now'])
  }
  expect(await f.events()).toEqual(before)
  expect(f.sends()).toHaveLength(1)
})

it('reconciles an interrupted shift and keeps the late confirmation for retry', async () => {
  let interrupted = false
  const f = await confirmedBooking({
    persistent: true,
    checkpoint(point) {
      if (interrupted && point === 'after_insert') throw new Error('power lost')
    },
  })
  const input = tap(await lateCard(f), shift)
  interrupted = true
  await expect(f.runtime.execute(input)).rejects.toThrow('power lost')
  expect(await f.events()).toHaveLength(2)
  await f.restart()
  expect(await f.events()).toEqual([expect.objectContaining(shifted)])
  expect(f.sends()).toHaveLength(1)
  const recovery = (await f.runtime.hub.snapshot(tenant)).cards.find(
    (card) => card.requestId === input.requestId,
  )!
  expect(await f.runtime.execute(tap(recovery, 'Send now'))).toEqual({
    status: 'ok',
    receipt: '● Shifted to 15:15',
  })
  expect(f.sends().slice(1)).toEqual([
    expect.objectContaining({
      textSha256: textSha256('No problem, Alex! See you at 15:15.'),
    }),
  ])
})
