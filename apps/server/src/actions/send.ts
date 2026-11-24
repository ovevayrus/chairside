import type { ActionResponse, Card } from '@chairside/shared'
import { DateTime } from 'luxon'
import { sameInterval } from '../calendar/adapter.js'
import {
  activateOffer,
  endActiveOffers,
  insertOffer,
  setOfferStatus,
} from '../db/offers.js'
import type { RequestRow } from '../db/requests.js'
import { displayText, proposal, type Proposal } from '../requests/cards.js'
import { DEFAULT_TIMEOUT_MS, TelegramApiError } from '../telegram/adapter.js'
import {
  finish,
  replaceCard,
  type ActionContext,
  type ActionRow,
} from './context.js'

function replyKind(p: Proposal) {
  const kind = p.kind.replace(/^retry_/, '')
  switch (kind) {
    case 'book':
    case 'offer_accepted':
    case 'offer':
    case 'ask_day':
    case 'ask_time':
      return kind
    default:
      throw new Error('Invalid reply proposal')
  }
}

function isConfirmation(p: Proposal) {
  const kind = replyKind(p)
  return kind === 'book' || kind === 'offer_accepted'
}

/** The slot an offer reply puts on the table (offers.ts accepts it later). */
function offeredSlot(p: Proposal) {
  return replyKind(p) === 'offer' && p.slot_start_utc && p.slot_end_utc
    ? { startUtc: p.slot_start_utc, endUtc: p.slot_end_utc }
    : undefined
}

function updateBookingReply(
  ctx: ActionContext,
  row: RequestRow,
  p: Proposal,
  status: string,
) {
  if (isConfirmation(p)) {
    ctx.store.db
      .prepare(
        `UPDATE bookings SET reply_status=?
      WHERE shop_id=? AND request_id=? AND slot_start_utc=?`,
      )
      .run(status, row.shop_id, row.id, p.slot_start_utc)
  }
}

export function recoveryCard(
  ctx: ActionContext,
  row: RequestRow,
  p: Proposal,
  label: 'Retry send' | 'Send now',
): Card {
  const slot =
    p.slot_start_utc && p.slot_end_utc
      ? { startUtc: p.slot_start_utc, endUtc: p.slot_end_utc }
      : undefined
  return replaceCard(
    ctx,
    row,
    label === 'Retry send' ? 'send_failed' : 'reply_not_sent',
    [
      proposal(`retry_${replyKind(p)}`, label, slot),
      proposal('not_now', 'Not now'),
    ],
  )
}

/** An unanswered send may already have reached the customer. There is no retry action. */
export function unknownReply(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): ActionResponse {
  return ctx.store.transaction(() => {
    updateBookingReply(ctx, row, p, 'reply_unknown')
    // The customer may never have seen this offer, so a "yes" can't accept it.
    if (offeredSlot(p)) setOfferStatus(ctx.store, action.id, 'unknown')
    const booked = isConfirmation(p)
    const card = replaceCard(ctx, row, 'reply_unknown', [
      proposal(booked ? 'unknown_book' : 'unknown_reply', 'Not now'),
    ])
    return finish(ctx, action, {
      status: 'reply_unknown',
      card,
      receipt: booked
        ? 'Booked · reply status unknown · check Telegram'
        : 'Reply status unknown · check Telegram',
    })
  })
}

// The owner may have moved or removed the appointment since this retry card was created.
async function confirmExistingBooking(
  ctx: ActionContext,
  row: RequestRow,
  p: Proposal,
): Promise<boolean> {
  if (!p.slot_start_utc || !p.slot_end_utc) return false
  const startUtc = p.slot_start_utc
  const endUtc = p.slot_end_utc
  const booking = ctx.store.db
    .prepare(
      `SELECT id,calendar_event_id FROM bookings
    WHERE shop_id=? AND request_id=? AND slot_start_utc=? AND slot_end_utc=?`,
    )
    .get(row.shop_id, row.id, startUtc, endUtc)
  if (!booking) return false
  try {
    const event = await ctx.calendar.getEvent(String(booking.calendar_event_id))
    if (
      !event ||
      event.privateProps.chairsideBookingId !== booking.id ||
      event.privateProps.requestId !== row.id ||
      !sameInterval(event, { startUtc, endUtc })
    )
      return false
    const events = await ctx.calendar.listEvents(startUtc, endUtc)
    const overlapping = events.filter(
      (other) =>
        Date.parse(other.startUtc) < Date.parse(endUtc) &&
        Date.parse(other.endUtc) > Date.parse(startUtc),
    )
    return overlapping.length === 1 &&
      overlapping[0]!.id === event.id &&
      overlapping[0]!.privateProps.chairsideBookingId === booking.id &&
      sameInterval(overlapping[0]!, {startUtc,endUtc})
  } catch {
    return false
  }
}

function slotTime(ctx: ActionContext, p: Proposal) {
  const timestamp = p.slot_start_utc ?? ctx.store.now().toISOString()
  return DateTime.fromISO(timestamp, {
    zone: ctx.store.shop.timezone,
  }).setLocale('en')
}

function replyText(ctx: ActionContext, row: RequestRow, p: Proposal): string {
  const { shop } = ctx.store
  const local = slotTime(ctx, p)
  const fields: Record<string, string> = {
    day: local.toFormat('cccc'),
    date: local.toFormat('d LLL'),
    time: local.toFormat('HH:mm'),
    name: row.customer_first_name,
    service:
      shop.services.find((s) => s.id === row.service_id)?.name ?? 'appointment',
  }
  return shop.replyTemplates[replyKind(p)].replace(
    /\{(day|date|time|name|service)\}/g,
    (_, key: string) => fields[key]!,
  )
}

function sentReceipt(ctx: ActionContext, row: RequestRow, p: Proposal): string {
  const when = slotTime(ctx, p).toFormat('ccc d LLL HH:mm')
  switch (replyKind(p)) {
    case 'book':
      return `● Booked ${when}`
    case 'offer_accepted':
      return `● ${displayText(row.customer_first_name, 24) || 'Customer'} accepted · Booked ${when}`
    case 'offer':
      return `● Offered ${when}`
    case 'ask_day':
      return '● Asked which day suits'
    case 'ask_time':
      return '● Asked what time suits'
  }
}

export async function sendReply(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): Promise<ActionResponse> {
  const { store, telegram } = ctx
  if (
    p.kind.startsWith('retry_') &&
    isConfirmation(p) &&
    !(await confirmExistingBooking(ctx, row, p))
  ) {
    return store.transaction(() =>
      finish(ctx, action, {
        status: 'error',
        receipt: 'Check the calendar · booking could not be confirmed',
        card: recoveryCard(ctx, row, p, 'Retry send'),
      }),
    )
  }
  if (store.replyBlock(row)) {
    return store.transaction(() => {
      const booked = isConfirmation(p)
      updateBookingReply(ctx, row, p, 'reply_not_sent')
      return finish(ctx, action, {
        status: 'window_closed',
        card: booked ? recoveryCard(ctx, row, p, 'Send now') : store.card(row),
        receipt: booked ? 'Booked · reply not sent' : 'Reply not sent',
      })
    })
  }
  const text = replyText(ctx, row, p)
  const connection = store.connection()
  const opts = {
    connectionId: store.business ? (connection.id ?? undefined) : undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  const offer = offeredSlot(p)
  store.transaction(() => {
    // Any newer message from the shop ends the chat's open offer: a later
    // "yes" could answer that message instead.
    endActiveOffers(store, row.chat_id, 'superseded')
    if (offer)
      insertOffer(store, {
        id: action.id,
        requestId: row.id,
        chatId: row.chat_id,
        slot: offer,
      })
    store.db
      .prepare(
        "UPDATE actions SET state='send_started',updated_at=? WHERE id=?",
      )
      .run(store.now().toISOString(), action.id)
  })
  ctx.checkpoint?.('after_send_started')

  let messageId: number
  try {
    const sent =
      offer && ctx.callbacksSupported
        ? await telegram.sendWithButton(
            row.chat_id,
            text,
            {
              text: `Book ${slotTime(ctx, p).toFormat('HH:mm')}`,
              callbackData: `offer:${action.id}`,
            },
            opts,
          )
        : await telegram.sendText(row.chat_id, text, opts)
    messageId = sent.messageId
  } catch (error) {
    if (
      error instanceof TelegramApiError &&
      error.code >= 400 &&
      error.code < 500
    ) {
      return store.transaction(() => {
        if (offer) setOfferStatus(store, action.id, 'failed')
        updateBookingReply(ctx, row, p, 'send_failed')
        return finish(ctx, action, {
          status: 'send_failed',
          card: recoveryCard(ctx, row, p, 'Retry send'),
          receipt: isConfirmation(p)
            ? 'Booked · Telegram reply failed'
            : 'Telegram reply failed',
        })
      })
    }
    return unknownReply(ctx, action, row, p)
  }

  const response = store.transaction(() => {
    store.db
      .prepare('UPDATE actions SET telegram_message_id=? WHERE id=?')
      .run(messageId, action.id)
    if (offer) activateOffer(store, action.id, messageId)
    updateBookingReply(ctx, row, p, 'sent')
    store.close(row.id, 'handled')
    return finish(
      ctx,
      action,
      { status: 'ok', receipt: sentReceipt(ctx, row, p) },
      'sent',
    )
  })
  const source = store.lastMessage(row.id)
  if (
    store.business &&
    source &&
    connection.id === source.connection_id &&
    connection.rights.canReadMessages
  ) {
    void telegram
      .markRead(row.chat_id, source.message_id, source.connection_id)
      .catch(() => {})
  }
  return response
}
