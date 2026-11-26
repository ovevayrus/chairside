import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { isAcceptance } from '../src/actions/offers.js'
import { eventIdFor } from '../src/calendar/eventId.js'
import { OFFER_TTL_MS, type OfferRow } from '../src/db/offers.js'
import type { CallbackEvent } from '../src/telegram/events.js'
import { textSha256 } from '../src/telegram/fake.js'
import {
  bookingFixture,
  connectionId,
  customerId,
  expectedSlot,
  requestText,
  tap,
  tenant,
} from './booking-fixture.js'

type Fixture = Awaited<ReturnType<typeof bookingFixture>>

const omar = customerId + 1
const at16 = {
  startUtc: '2026-12-05T12:00:00.000Z',
  endUtc: '2026-12-05T12:45:00.000Z',
}
const offerText =
  'Hi Omar! I can do Skin fade on Saturday 5 Dec at 16:00. Does that work?'
const confirmation =
  'See you on Saturday 5 Dec at 16:00, Omar! Your Skin fade is booked.'
const notAvailable = textSha256('This offer is not available')
let nextUpdate = 9_000

function offers(f: Fixture) {
  return f.db
    .prepare('SELECT * FROM offers ORDER BY rowid')
    .all() as unknown as OfferRow[]
}

function acceptance(f: Fixture, offer: OfferRow) {
  return f.db
    .prepare('SELECT * FROM actions WHERE idempotency_key=?')
    .get(`offer:${offer.id}`) as unknown as
    { id: string; state: string } | undefined
}

/** Lets the debounce fire, then waits for everything queued on the shop lock. */
async function settle(f: Fixture, ms = 10) {
  await delay(ms)
  await f.runtime.store.withLock(async () => {})
}

async function reply(
  f: Fixture,
  text: string,
  chatId = omar,
  firstName = 'Omar',
  ms?: number,
) {
  await f.receive(text, chatId, firstName)
  await settle(f, ms)
}

function cards(f: Fixture, chatId = omar) {
  const { store } = f.runtime
  return store.pending(chatId).map((row) => store.card(row))
}

/** Demo moment 2: 15:00 is gone, so Omar's card offers 16:00 and the owner taps it. */
async function offerAt16(f: Fixture) {
  f.calendar.addForeignEvent(expectedSlot)
  const card = await f.cardFor(requestText, omar, 'Omar')
  expect(await f.runtime.execute(tap(card, 'Offer Sat 5 Dec 16:00'))).toEqual({
    status: 'ok',
    receipt: '● Offered Sat 5 Dec 16:00',
  })
  expect(f.sends()).toEqual([
    expect.objectContaining({
      chatId: omar,
      connectionId,
      textSha256: textSha256(offerText),
    }),
  ])
  const offer = offers(f).at(-1)!
  expect(offer).toMatchObject({
    request_id: card.requestId,
    chat_id: omar,
    slot_start_utc: at16.startUtc,
    slot_end_utc: at16.endUtc,
    status: 'active',
    offer_message_id: f.sends()[0]!.messageId,
  })
  return offer
}

/**
 * Two of Omar's cards are visible at once (a failed offer's retry card and a
 * new request). The owner offers 17:15 on the new card, then retries 16:00.
 */
async function twoOffers(f: Fixture) {
  f.calendar.addForeignEvent(expectedSlot)
  const first = await f.cardFor(requestText, omar, 'Omar')
  f.telegram.failNext({ code: 400 }, 'sendText')
  const failed = await f.runtime.execute(tap(first, 'Offer Sat 5 Dec 16:00'))
  expect(failed.status).toBe('send_failed')
  const second = await f.cardFor(
    'Skin fade on Saturday 5 Dec at 5pm',
    omar,
    'Omar',
  )
  expect(second.requestId).not.toBe(first.requestId)
  const at1715 = tap(second, 'Offer Sat 5 Dec 17:15')
  expect((await f.runtime.execute(at1715)).status).toBe('ok')
  const older = offers(f).at(-1)!
  expect(older.status).toBe('active')
  const retry = tap(failed.card!, 'Retry send')
  expect((await f.runtime.execute(retry)).status).toBe('ok')
  return { older, newer: offers(f).at(-1)! }
}

describe('offer acceptance', () => {
  it('accepts only whole whitelisted replies after normalisation', () => {
    for (const text of [
      'yes',
      'Yes!',
      ' YES. ',
      'yep',
      'yeah',
      'ok',
      'OK!!',
      'okay',
      'sure',
      'perfect',
      'deal',
      'Sounds   good!',
      'works for me',
      '👍',
      '👍🏽',
      'yes thanks',
      'Yes, thank you!',
      'ok thanks',
      '👍 thanks',
      'works for me thank you.',
    ])
      expect(isAcceptance(text), text).toBe(true)
    for (const text of [
      'no',
      "I can't do 4",
      'yes but 5 is better',
      'yes?',
      'ok?',
      'thanks',
      'yes yes',
      'yes please',
      'not ok',
      'y',
      '👍👍',
      '',
    ])
      expect(isAcceptance(text), text).toBe(false)
  })

  it('keeps one active offer per chat: a new offer supersedes the old one', async () => {
    const f = await bookingFixture()
    const { older, newer } = await twoOffers(f)
    expect(offers(f).map((o) => [o.id, o.status])).toEqual([
      [expect.any(String), 'failed'],
      [older.id, 'superseded'],
      [newer.id, 'active'],
    ])
    expect(newer).toMatchObject({
      chat_id: omar,
      slot_start_utc: at16.startUtc,
    })
    expect(() =>
      f.db.prepare("UPDATE offers SET status='active'").run(),
    ).toThrow(/UNIQUE constraint failed: offers\.chat_id/)
  })

  it('books a plain "yes" exactly once and a repeated "yes" adds nothing', async () => {
    const f = await bookingFixture()
    const offer = await offerAt16(f)
    const broadcast = vi.spyOn(f.runtime.hub, 'broadcast')
    await reply(f, 'yes')
    const action = acceptance(f, offer)!
    expect(action.state).toBe('sent')
    const events = await f.events()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      ...at16,
      // Seeded with the action row, as every executor booking is.
      id: eventIdFor(tenant, `${offer.request_id}:${action.id}`, at16.startUtc),
      summary: 'Chairside · Omar · Skin fade',
      privateProps: {
        chairsideBookingId: action.id,
        requestId: offer.request_id,
      },
    })
    expect(f.bookings()).toEqual([
      expect.objectContaining({
        slot_start_utc: at16.startUtc,
        reply_status: 'sent',
      }),
    ])
    expect(f.sends().map((s) => s.textSha256)).toEqual([
      textSha256(offerText),
      textSha256(confirmation),
    ])
    expect(broadcast).toHaveBeenCalledWith(tenant, {
      type: 'receipt',
      requestId: offer.request_id,
      // The acceptance's own key: the glasses that sent the offer still show it.
      idempotencyKey: `offer:${offer.id}`,
      text: '● Omar accepted · Booked Sat 5 Dec 16:00',
    })
    expect(offers(f)[0]?.status).toBe('accepted')
    for (const again of ['yes', 'Yes!']) {
      await reply(f, again)
      expect(f.bookings()).toHaveLength(1)
      expect(await f.events()).toHaveLength(2)
      expect(f.sends()).toHaveLength(2)
      expect(cards(f)).toEqual([])
    }
  })

  it.each(["I can't do 4", 'no', 'yes but 5 is better'])(
    'sends %j to the owner as a card and books nothing',
    async (text) => {
      const f = await bookingFixture()
      const offer = await offerAt16(f)
      await reply(f, text)
      expect(cards(f)).toEqual([
        expect.objectContaining({
          header: 'NEEDS YOU',
          lines: ['Omar'],
          actions: [expect.objectContaining({ label: 'Not now' })],
        }),
      ])
      expect(offers(f)[0]?.status).toBe('answered')
      // The offer was answered, so a later "yes" is an ordinary message too.
      await reply(f, 'yes')
      expect(cards(f)).toHaveLength(1)
      expect(acceptance(f, offer)).toBeUndefined()
      expect(f.bookings()).toEqual([])
      expect(await f.events()).toHaveLength(1)
      expect(f.sends()).toHaveLength(1)
    },
  )

  it('does not book an expired offer', async () => {
    const f = await bookingFixture()
    await offerAt16(f)
    f.advance(OFFER_TTL_MS)
    await reply(f, 'yes')
    expect(offers(f)[0]?.status).toBe('expired')
    expect(cards(f)).toEqual([expect.objectContaining({ header: 'NEEDS YOU' })])
    expect(f.bookings()).toEqual([])
    expect(f.sends()).toHaveLength(1)
  })

  it('never books a superseded offer', async () => {
    const f = await bookingFixture()
    const { older, newer } = await twoOffers(f)
    await reply(f, 'yes')
    expect(acceptance(f, older)).toBeUndefined()
    expect(acceptance(f, newer)?.state).toBe('sent')
    // 17:15 stays free: only the newest offer (16:00) was booked.
    expect((await f.events()).map((e) => e.startUtc)).toEqual([
      expectedSlot.startUtc,
      at16.startUtc,
    ])
    expect(f.bookings()).toEqual([
      expect.objectContaining({ slot_start_utc: at16.startUtc }),
    ])
  })

  it('treats a "yes" from another chat as an ordinary request', async () => {
    const f = await bookingFixture()
    const nina = customerId + 2
    await offerAt16(f)
    await reply(f, 'yes', nina, 'Nina')
    expect(cards(f, nina)).toEqual([
      expect.objectContaining({ header: 'NEEDS YOU', lines: ['Nina'] }),
    ])
    expect(f.bookings()).toEqual([])
    expect(f.sends()).toHaveLength(1)
    expect(offers(f)[0]?.status).toBe('active')
    await reply(f, 'yes')
    expect(f.bookings()).toHaveLength(1)
  })

  it.each(['the owner writes by hand', 'the offer message is deleted'])(
    'ends the offer when %s',
    async (change) => {
      const f = await bookingFixture()
      const offer = await offerAt16(f)
      const updateId = nextUpdate++
      await f.telegram.emit(
        change === 'the owner writes by hand'
          ? {
              type: 'message',
              updateId,
              connectionId,
              chatId: omar,
              messageId: updateId,
              fromId: 1,
              firstName: 'Karim',
              text: 'Or would 5pm suit you better?',
              dateIso: f.now().toISOString(),
              direction: 'outgoing_owner',
            }
          : {
              type: 'deleted',
              updateId,
              connectionId,
              chatId: omar,
              messageIds: [offer.offer_message_id!],
            },
      )
      await reply(f, 'yes')
      expect(offers(f)[0]?.status).toBe(
        change === 'the owner writes by hand' ? 'superseded' : 'withdrawn',
      )
      expect(cards(f)).toEqual([
        expect.objectContaining({ header: 'NEEDS YOU' }),
      ])
      expect(f.bookings()).toEqual([])
      expect(f.sends()).toHaveLength(1)
    },
  )

  it('ends the offer when the shop sends another reply in the chat', async () => {
    const f = await bookingFixture()
    // Omar's first request is booked, but its confirmation failed.
    const first = await f.cardFor(requestText, omar, 'Omar')
    f.telegram.failNext({ code: 400 }, 'sendText')
    const failed = await f.runtime.execute(tap(first))
    expect(failed.status).toBe('send_failed')
    const second = await f.cardFor(
      'Skin fade on Saturday 5 Dec at 5pm',
      omar,
      'Omar',
    )
    await f.runtime.execute(tap(second, 'Offer Sat 5 Dec 17:15'))
    expect(offers(f)[0]?.status).toBe('active')
    // The confirmation goes out after the offer, so a "yes" could answer either.
    const retry = tap(failed.card!, 'Retry send')
    expect((await f.runtime.execute(retry)).status).toBe('ok')
    expect(offers(f)[0]?.status).toBe('superseded')
    await reply(f, 'yes')
    expect(cards(f)).toEqual([expect.objectContaining({ header: 'NEEDS YOU' })])
    expect(f.bookings()).toEqual([
      expect.objectContaining({ slot_start_utc: expectedSlot.startUtc }),
    ])
  })

  it('cannot accept an offer whose delivery is unknown', async () => {
    const f = await bookingFixture()
    f.calendar.addForeignEvent(expectedSlot)
    const card = await f.cardFor(requestText, omar, 'Omar')
    f.telegram.failNext('timeout', 'sendText')
    const sent = await f.runtime.execute(tap(card, 'Offer Sat 5 Dec 16:00'))
    expect(sent.status).toBe('reply_unknown')
    expect(offers(f)[0]?.status).toBe('unknown')
    await reply(f, 'yes')
    expect(f.bookings()).toEqual([])
    expect(f.sends()).toHaveLength(1)
  })

  it('never treats a reply written before the offer as its acceptance', async () => {
    const f = await bookingFixture({ debounceMs: 150 })
    f.calendar.addForeignEvent(expectedSlot)
    const card = await f.cardFor(requestText, omar, 'Omar')
    f.telegram.failNext({ code: 400 }, 'sendText')
    const failed = await f.runtime.execute(tap(card, 'Offer Sat 5 Dec 16:00'))
    // Omar writes while no offer is open; the retried offer lands before his batch flushes.
    await f.receive('ok', omar, 'Omar')
    const retry = tap(failed.card!, 'Retry send')
    expect((await f.runtime.execute(retry)).status).toBe('ok')
    await settle(f, 200)
    expect(cards(f)).toEqual([expect.objectContaining({ header: 'NEEDS YOU' })])
    expect(f.bookings()).toEqual([])
    expect(offers(f).at(-1)?.status).toBe('active')
    await reply(f, 'yes', omar, 'Omar', 200)
    expect(f.bookings()).toHaveLength(1)
    // The ordinary card that "yes" briefly began to update is back as it was.
    expect(cards(f)).toEqual([expect.objectContaining({ header: 'NEEDS YOU' })])
  })

  it('sends nothing when the slot was taken before the yes and offers the owner the next opening', async () => {
    const f = await bookingFixture()
    const offer = await offerAt16(f)
    f.calendar.addForeignEvent({ id: 'walk-in', ...at16 })
    const broadcast = vi.spyOn(f.runtime.hub, 'broadcast')
    const insert = vi.spyOn(f.calendar, 'insertEvent')
    await reply(f, 'yes')
    expect(insert).not.toHaveBeenCalled()
    expect(f.sends()).toHaveLength(1)
    expect(f.bookings()).toEqual([])
    expect(acceptance(f, offer)?.state).toBe('slot_taken')
    const [card] = cards(f)
    expect(card).toMatchObject({
      requestId: offer.request_id,
      header: 'NEEDS YOU',
      lines: ['Omar said yes to Sat 16:00', 'but it was just taken'],
    })
    expect(card!.actions.map((a) => a.label)).toEqual([
      'Offer Sat 5 Dec 17:00',
      'Offer Sat 5 Dec 17:15',
      'Ask for another time',
    ])
    expect(broadcast).toHaveBeenCalledWith(tenant, {
      type: 'card.upsert',
      card: expect.objectContaining({ requestId: offer.request_id }),
    })
    expect(broadcast).toHaveBeenCalledWith(tenant, {
      type: 'receipt',
      requestId: offer.request_id,
      idempotencyKey: `offer:${offer.id}`,
      text: 'Omar said yes · slot just taken',
    })
    // One tap offers the next opening and Omar's next "yes" books it.
    const next = await f.runtime.execute(tap(card!, 'Offer Sat 5 Dec 17:00'))
    expect(next.status).toBe('ok')
    await reply(f, 'yes')
    expect(f.bookings()).toEqual([
      expect.objectContaining({ slot_start_utc: '2026-12-05T13:00:00.000Z' }),
    ])
    expect(f.sends()).toHaveLength(3)
  })

  describe('with CALLBACKS_SUPPORTED', () => {
    function press(
      f: Fixture,
      offer: OfferRow,
      changes: Partial<CallbackEvent> = {},
    ) {
      const updateId = nextUpdate++
      const event: CallbackEvent = {
        type: 'callback',
        updateId,
        callbackQueryId: `press-${updateId}`,
        fromId: omar,
        chatId: omar,
        messageId: offer.offer_message_id!,
        data: `offer:${offer.id}`,
        connectionId,
        ...changes,
      }
      return f.telegram.emit(event).then(() => event.callbackQueryId)
    }

    function answers(f: Fixture) {
      return f.telegram.calls
        .filter((c) => c.method === 'answerCallback')
        .map((c) => [c.callbackQueryId, c.textSha256])
    }

    it('rejects a press from the wrong user and answers every press', async () => {
      const f = await bookingFixture({ callbacksSupported: true })
      const offer = await offerAt16(f)
      expect(f.sends()[0]).toMatchObject({
        method: 'sendWithButton',
        callbackData: `offer:${offer.id}`,
      })
      const rejected = [
        await press(f, offer, { fromId: 1 }),
        await press(f, offer, { fromId: omar + 7 }),
        await press(f, offer, { messageId: offer.offer_message_id! + 1 }),
        await press(f, offer, { data: 'offer:forged' }),
      ]
      expect(f.bookings()).toEqual([])
      expect(f.sends()).toHaveLength(1)
      const accepted = [await press(f, offer), await press(f, offer)]
      expect(f.bookings()).toHaveLength(1)
      expect(f.sends().map((s) => s.textSha256)).toEqual([
        textSha256(offerText),
        textSha256(confirmation),
      ])
      expect(answers(f)).toEqual([
        ...rejected.map((id) => [id, notAvailable]),
        ...accepted.map((id) => [id, undefined]),
      ])
    })

    it('answers a press without acting when callbacks are off', async () => {
      const f = await bookingFixture()
      const offer = await offerAt16(f)
      expect(f.sends()[0]?.method).toBe('sendText')
      const id = await press(f, offer)
      expect(answers(f)).toEqual([[id, notAvailable]])
      expect(f.bookings()).toEqual([])
      expect(offers(f)[0]?.status).toBe('active')
    })
  })

  it('gives the owner a card for an acceptance cut off before booking', async () => {
    const f = await bookingFixture({ persistent: true })
    const offer = await offerAt16(f)
    // The process dies while the acceptance waits for free/busy.
    vi.spyOn(f.calendar, 'freeBusy').mockImplementationOnce(
      () => new Promise(() => {}),
    )
    await f.receive('yes', omar, 'Omar')
    await vi.waitFor(() => expect(acceptance(f, offer)?.state).toBe('received'))
    await f.restart()
    expect(acceptance(f, offer)?.state).toBe('failed')
    const [card] = cards(f)
    expect(card).toMatchObject({
      requestId: offer.request_id,
      header: 'NEW REQUEST',
      lines: ['Omar · Skin fade', 'Sat 5 Dec · 16:00 · ● free (45 min)'],
    })
    expect(f.sends()).toHaveLength(1)
    expect(f.bookings()).toEqual([])
    // Nothing is booked or sent until the owner taps.
    expect((await f.runtime.execute(tap(card!))).status).toBe('ok')
    expect(f.bookings()).toEqual([
      expect.objectContaining({ slot_start_utc: at16.startUtc }),
    ])
  })

  it.each(['after_insert', 'after_send_started'] as const)(
    'reconciles an acceptance interrupted %s without sending',
    async (stage) => {
      let armed = false
      const f = await bookingFixture({
        persistent: true,
        checkpoint: (point) => {
          if (armed && point === stage) throw new Error('power lost')
        },
      })
      const offer = await offerAt16(f)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      onTestFinished(() => errors.mockRestore())
      armed = true
      await reply(f, 'yes')
      armed = false
      expect(errors).toHaveBeenCalledOnce()
      expect(acceptance(f, offer)?.state).toBe(
        stage === 'after_insert' ? 'calendar_pending' : 'send_started',
      )
      expect(await f.events()).toHaveLength(2)
      await f.restart()
      expect(f.sends()).toHaveLength(1)
      expect(f.bookings()).toHaveLength(1)
      const [card] = cards(f)
      if (stage === 'after_insert') {
        expect(card!.lines).toContain('Booked, reply not sent · Send now?')
        const send = tap(card!, 'Send now')
        expect((await f.runtime.execute(send)).status).toBe('ok')
        await f.runtime.execute(send)
        expect(f.sends().map((s) => s.textSha256)).toEqual([
          textSha256(offerText),
          textSha256(confirmation),
        ])
      } else {
        expect(card).toMatchObject({ header: 'BOOKED' })
        expect(f.bookings()[0]?.reply_status).toBe('reply_unknown')
        expect(f.sends()).toHaveLength(1)
      }
      expect(await f.events()).toHaveLength(2)
    },
  )
})

describe('move offer acceptance', () => {
  async function offerMove(f: Fixture) {
    const booking = await f.cardFor(requestText, omar, 'Omar')
    expect((await f.runtime.execute(tap(booking))).status).toBe('ok')
    const [original] = await f.events()
    const blocker = f.calendar.addForeignEvent({
      startUtc: at16.startUtc,
      endUtc: '2026-12-05T12:10:00.000Z',
    })
    const move = await f.cardFor('can I come at 4 instead', omar, 'Omar')
    expect(move).toMatchObject({
      header: 'WANTS TO MOVE',
      lines: ['Omar · Skin fade', 'Sat 5 Dec 15:00 ▶ 16:00 · ○ taken'],
    })
    expect(
      (await f.runtime.execute(tap(move, 'Offer Sat 5 Dec 16:15'))).status,
    ).toBe('ok')
    expect(await f.events()).toEqual([original, blocker])
    expect(f.bookings()).toEqual([
      expect.objectContaining({ status: 'active' }),
    ])
    expect(f.sends()).toHaveLength(2)
    const offer = offers(f).at(-1)!
    expect(offer).toMatchObject({
      status: 'active',
      booking_id: original!.privateProps.chairsideBookingId,
    })
    return { offer, original: original!, blocker }
  }

  it.each(['yes', 'inline button'])(
    'moves the booking exactly once after %s',
    async (mode) => {
      const f = await bookingFixture({
        callbacksSupported: mode === 'inline button',
      })
      const { offer, original, blocker } = await offerMove(f)
      const accept = async () => {
        if (mode === 'yes') return reply(f, 'yes')
        const updateId = nextUpdate++
        await f.telegram.emit({
          type: 'callback',
          updateId,
          callbackQueryId: `move-${updateId}`,
          fromId: omar,
          chatId: omar,
          messageId: offer.offer_message_id!,
          data: f.sends()[1]!.callbackData!,
          connectionId,
        })
      }
      await accept()
      await accept()
      expect(await f.events()).toEqual([
        blocker,
        expect.objectContaining({
          startUtc: '2026-12-05T12:15:00.000Z',
          endUtc: '2026-12-05T13:00:00.000Z',
        }),
      ])
      expect(f.bookings()).toEqual([
        expect.objectContaining({
          status: 'moved',
          calendar_event_id: original.id,
        }),
        expect.objectContaining({
          status: 'active',
          replaced_booking_id: original.privateProps.chairsideBookingId,
        }),
      ])
      expect(f.sends()).toHaveLength(3)
      expect(f.sends()[2]).toMatchObject({
        chatId: omar,
        connectionId,
        textSha256: textSha256(
          'Done! Your Skin fade is now on Saturday 5 Dec at 16:15, Omar.',
        ),
      })
      expect(offers(f)[0]?.status).toBe('accepted')
      expect(cards(f)).toEqual([])
    },
  )

  it('keeps the old booking if a move offer is taken before acceptance', async () => {
    const f = await bookingFixture()
    const { original } = await offerMove(f)
    f.calendar.addForeignEvent({
      startUtc: '2026-12-05T12:15:00.000Z',
      endUtc: '2026-12-05T13:00:00.000Z',
    })
    await reply(f, 'yes')
    expect(await f.events()).toContainEqual(original)
    expect(f.bookings()).toEqual([
      expect.objectContaining({ status: 'active' }),
    ])
    expect(f.sends()).toHaveLength(2)
    const [next] = cards(f)
    expect(next!.actions[0]?.label).toBe('Offer Sat 5 Dec 17:15')
    expect(
      (await f.runtime.execute(tap(next!, 'Offer Sat 5 Dec 17:15'))).status,
    ).toBe('ok')
    await reply(f, 'yes')
    expect(f.bookings()).toEqual([
      expect.objectContaining({ status: 'moved' }),
      expect.objectContaining({
        status: 'active',
        slot_start_utc: '2026-12-05T13:15:00.000Z',
      }),
    ])
    expect(await f.events()).not.toContainEqual(original)
    expect(f.sends()).toHaveLength(4)
  })
})
