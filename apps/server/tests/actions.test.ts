import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { textSha256 } from '../src/telegram/fake.js'
import {
  bookingFixture,
  connectionId,
  customerId,
  expectedSlot,
  tap,
  tenant,
} from './booking-fixture.js'

describe('owner actions', () => {
  it('books and replies by POST within 1.5 seconds', async () => {
    const f = await bookingFixture()
    const card = await f.cardFor()
    const broadcast = vi.spyOn(f.runtime.hub, 'broadcast')
    const freeBusy = vi.spyOn(f.calendar, 'freeBusy')
    const send = f.telegram.sendText.bind(f.telegram)
    let sendStarted: number | undefined
    vi.spyOn(f.telegram, 'sendText').mockImplementation((...args) => {
      sendStarted = performance.now()
      return send(...args)
    })
    const started = performance.now()
    const input = tap(card)
    const { http, body } = await f.postAction(input)
    expect(http).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.receipt).toBeTruthy()
    expect(sendStarted).toBeDefined()
    expect(sendStarted! - started).toBeLessThan(1_500)
    expect(freeBusy).toHaveBeenCalledWith(
      '2026-12-05T10:55:00.000Z',
      '2026-12-05T11:50:00.000Z',
    )
    const events = await f.events()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      ...expectedSlot,
      summary: 'Chairside · Anna · Skin fade',
      privateProps: {
        requestId: card.requestId,
        chairsideBookingId: expect.any(String),
      },
    })
    expect(f.bookings()).toHaveLength(1)
    expect(f.sends()).toEqual([
      expect.objectContaining({
        chatId: customerId,
        connectionId,
        textSha256: textSha256(
          'Booked! Skin fade on Saturday 5 Dec at 15:00. See you, Anna!',
        ),
      }),
    ])
    expect(broadcast).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        type: 'receipt',
        text: body.receipt,
        // Names the action, so the device that tapped can skip its own receipt.
        idempotencyKey: input.idempotencyKey,
      }),
    )
    expect((await f.runtime.hub.snapshot(tenant)).cards).toEqual([])
  })

  it('replays the same key without another booking or reply', async () => {
    const f = await bookingFixture()
    const input = tap(await f.cardFor())
    const first = await f.postAction(input)
    expect(first.body.status).toBe('ok')
    expect(await f.postAction(input)).toEqual(first)
    expect(await f.events()).toHaveLength(1)
    expect(f.sends()).toHaveLength(1)
    expect(f.bookings()).toHaveLength(1)
  })

  it('serializes concurrent keys and competing proposals', async () => {
    const f = await bookingFixture()
    const card = await f.cardFor()
    const book = tap(card)
    const offer = card.actions.find((a) => a.label.startsWith('Offer'))!
    const [first, replay, competing] = await Promise.all([
      f.runtime.execute(book),
      f.runtime.execute({ ...book, idempotencyKey: randomUUID() }),
      f.runtime.execute(tap(card, offer.label)),
    ])
    expect(first.status).toBe('ok')
    expect(replay).toEqual(first)
    expect(competing.status).toBe('stale')
    expect(await f.events()).toHaveLength(1)
    expect(f.sends()).toHaveLength(1)
    expect(f.bookings()).toHaveLength(1)
  })

  it('rejects unauthorized, invalid and stale taps before side effects', async () => {
    const f = await bookingFixture()
    const old = await f.cardFor()
    const newer = await f.cardFor('Haircut on Saturday 5 Dec at 5pm')
    expect(newer.requestId).toBe(old.requestId)
    expect((await f.post(tap(newer), 'bad')).status).toBe(401)
    expect((await f.post({ requestId: newer.requestId })).status).toBe(400)
    const { http, body } = await f.postAction(tap(old))
    expect(http).toBe(409)
    expect(body).toMatchObject({
      status: 'stale',
      card: { requestId: newer.requestId, version: newer.version },
    })
    expect(await f.events()).toHaveLength(0)
    expect(f.sends()).toHaveLength(0)
  })

  it('rechecks a taken slot and offers a new opening', async () => {
    const f = await bookingFixture()
    const card = await f.cardFor()
    f.calendar.addForeignEvent(expectedSlot)
    const insert = vi.spyOn(f.calendar, 'insertEvent')
    const result = await f.runtime.execute(tap(card))
    expect(result.status).toBe('slot_taken')
    expect(result.card?.version).toBeGreaterThan(card.version)
    expect(result.card?.actions[0].label).toMatch(/^Offer /)
    expect(result.card?.lines.join(' ')).toMatch(/taken/i)
    expect(insert).not.toHaveBeenCalled()
    expect(f.bookings()).toHaveLength(0)
    expect(f.sends()).toHaveLength(0)
  })

  it.each(['freeBusyError', 'calendarLevelError'] as const)(
    'fails closed on %s',
    async (failure) => {
      const f = await bookingFixture()
      const input = tap(await f.cardFor())
      f.calendar.failures[failure] = true
      const result = await f.runtime.execute(input)
      expect(result.status).toBe('error')
      expect(result.card).toBeDefined()
      expect(await f.events()).toHaveLength(0)
      expect(f.bookings()).toHaveLength(0)
      expect(f.sends()).toHaveLength(0)
    },
  )

  it('rejects a foreign 409 without sending', async () => {
    const f = await bookingFixture()
    const input = tap(await f.cardFor())
    const insert = f.calendar.insertEvent.bind(f.calendar)
    vi.spyOn(f.calendar, 'insertEvent').mockImplementationOnce(
      async (planned) => {
        f.calendar.addForeignEvent({ id: planned.id, ...expectedSlot })
        return insert(planned)
      },
    )
    expect((await f.runtime.execute(input)).status).toBe('slot_taken')
    const events = await f.events()
    expect(events).toHaveLength(1)
    expect(events[0].privateProps).toEqual({})
    expect(f.bookings()).toHaveLength(0)
    expect(f.sends()).toHaveLength(0)
  })

  it('compensates an overlap and books the same request and slot again', async () => {
    const f = await bookingFixture()
    const card = await f.cardFor()
    const insert = f.calendar.insertEvent.bind(f.calendar)
    const inserts = vi
      .spyOn(f.calendar, 'insertEvent')
      .mockImplementationOnce(async (planned) => {
        const result = await insert(planned)
        f.calendar.addForeignEvent({ id: 'late-overlap', ...expectedSlot })
        return result
      })
    const result = await f.runtime.execute(tap(card))
    expect(result.status).toBe('slot_taken')
    expect((await f.events()).map((e) => e.id)).toEqual(['late-overlap'])
    expect(f.sends()).toHaveLength(0)
    expect(f.bookings()).toHaveLength(0)
    await f.calendar.deleteEvent('late-overlap')
    const next = await f.cardFor()
    expect(next.requestId).toBe(card.requestId)
    expect((await f.runtime.execute(tap(next))).status).toBe('ok')
    expect(inserts.mock.calls).toHaveLength(2)
    expect(inserts.mock.calls[0][0].id).not.toBe(inserts.mock.calls[1][0].id)
    expect(await f.events()).toHaveLength(1)
    expect(f.sends()).toHaveLength(1)
  })

  it.each(['timeout', 'network'] as const)(
    'keeps the booking after %s and never resends',
    async (failure) => {
      const f = await bookingFixture()
      const input = tap(await f.cardFor())
      f.telegram.failNext(failure, 'sendText')
      const first = await f.runtime.execute(input)
      expect(first.status).toBe('reply_unknown')
      await f.runtime.execute(input)
      await f.runtime.execute({ ...input, idempotencyKey: randomUUID() })
      expect(f.bookings()).toEqual([
        expect.objectContaining({ reply_status: 'reply_unknown' }),
      ])
      expect(await f.events()).toHaveLength(1)
      expect(f.sends()).toHaveLength(1)
      expect(
        (await f.runtime.hub.snapshot(tenant)).cards
          .flatMap((c) => c.actions)
          .some((a) => a.label === 'Retry send'),
      ).toBe(false)
    },
  )

  it('retries a definite 400 only after a fresh tap', async () => {
    const f = await bookingFixture()
    const book = tap(await f.cardFor())
    f.telegram.failNext({ code: 400 }, 'sendText')
    const failed = await f.runtime.execute(book)
    expect(failed.status).toBe('send_failed')
    expect(f.bookings()).toEqual([
      expect.objectContaining({ reply_status: 'send_failed' }),
    ])
    await f.runtime.execute(book)
    expect(f.sends()).toHaveLength(1)
    const retry = tap(failed.card!, 'Retry send')
    expect((await f.runtime.execute(retry)).status).toBe('ok')
    await f.runtime.execute(retry)
    expect(f.sends()).toHaveLength(2)
    expect(f.sends()[1].textSha256).toBe(f.sends()[0].textSha256)
    expect(await f.events()).toHaveLength(1)
    expect(f.bookings()).toHaveLength(1)
  })

  it('blocks a closed window and revoked rights at tap time', async () => {
    const f = await bookingFixture()
    const first = tap(await f.cardFor())
    f.advance(24 * 60 * 60 * 1000 + 1)
    const window = await f.runtime.execute(first)
    expect(window.status).toBe('window_closed')
    expect(window.card?.lines.join(' ')).toContain('24 h')
    const second = tap(await f.cardFor(undefined, customerId + 1, 'Nina'))
    await f.telegram.emit({
      type: 'connection',
      updateId: 999,
      connectionId,
      ownerUserId: 1,
      ownerChatId: 1,
      isEnabled: true,
      rights: {
        canReply: false,
        canReadMessages: true,
        canDeleteSentMessages: false,
        canDeleteAllMessages: false,
      },
    })
    expect((await f.runtime.execute(second)).status).toBe('window_closed')
    expect(await f.events()).toHaveLength(0)
    expect(f.sends()).toHaveLength(0)
  })

  it.each(['after_insert', 'after_send_started'] as const)(
    'reconciles %s on restart without sending',
    async (stage) => {
      const f = await bookingFixture({
        persistent: true,
        checkpoint: (point) => {
          if (stage === point) throw new Error('power lost')
        },
      })
      const input = tap(await f.cardFor())
      await expect(f.runtime.execute(input)).rejects.toThrow('power lost')
      expect(f.db.prepare('SELECT state FROM actions').get()?.state).toBe(
        stage === 'after_insert' ? 'calendar_pending' : 'send_started',
      )
      expect(await f.events()).toHaveLength(1)
      expect(f.sends()).toHaveLength(0)
      await f.restart()
      expect(f.sends()).toHaveLength(0)
      expect(f.bookings()).toHaveLength(1)
      const state = await f.runtime.hub.snapshot(tenant)
      if (stage === 'after_insert') {
        const recovery = state.cards.find(
          (c) => c.requestId === input.requestId,
        )!
        expect([recovery.header, ...recovery.lines].join(' ')).toMatch(
          /reply not sent/i,
        )
        const send = recovery.actions.find((a) => /send now/i.test(a.label))!
        const next = tap(recovery, send.label)
        expect((await f.runtime.execute(next)).status).toBe('ok')
        await f.runtime.execute(next)
        expect(f.sends()).toHaveLength(1)
      } else {
        expect(f.bookings()[0].reply_status).toBe('reply_unknown')
        const alert = state.cards.find((c) => c.requestId === input.requestId)!
        expect([alert.header, ...alert.lines].join(' ')).toMatch(/unknown/i)
        expect(alert.actions.map((a) => a.label)).toEqual(['Not now'])
        expect((await f.runtime.execute(input)).status).toBe('reply_unknown')
        expect(f.sends()).toHaveLength(0)
      }
      expect(await f.events()).toHaveLength(1)
    },
  )
})
