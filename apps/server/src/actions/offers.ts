import { randomUUID } from 'node:crypto'
import type { ActionResponse } from '@chairside/shared'
import { latestOffer, setOfferStatus, type OfferRow } from '../db/offers.js'
import type { RequestRow } from '../db/requests.js'
import { planProposals, proposal, type Proposal } from '../requests/cards.js'
import type { CallbackEvent } from '../telegram/events.js'
import { reserve } from './booking.js'
import {
  finish,
  replaceCard,
  replay,
  type ActionContext,
  type ActionRow,
} from './context.js'
import { sendReply } from './send.js'

/** Section 5.6 (b): the whole replies that accept an offer. A closed set. */
const ACCEPTANCES = new Set([
  'yes',
  'yep',
  'yeah',
  'ok',
  'okay',
  'sure',
  'perfect',
  'deal',
  'sounds good',
  'works for me',
  '👍',
])

// Trailing punctuation and spaces, except a question mark: "ok?" asks, it doesn't accept.
const TRAILING_PUNCTUATION = /(?:\s|[^\P{P}?])+$/u

/** Lowercase, trim, collapse spaces and strip trailing punctuation. */
export function normalizeReply(text: string): string {
  return (
    text
      .normalize('NFKC')
      // A thumbs up in any skin tone is the same 👍.
      .replace(/\p{Emoji_Modifier}|\u{FE0F}/gu, '')
      .toLowerCase()
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(TRAILING_PUNCTUATION, '')
  )
}

/** True only for a whitelisted reply, optionally followed by "thanks" or "thank you". */
export function isAcceptance(text: string): boolean {
  const reply = normalizeReply(text)
  const core = reply
    .replace(/ (?:thanks|thank you)$/u, '')
    .replace(TRAILING_PUNCTUATION, '')
  return ACCEPTANCES.has(reply) || ACCEPTANCES.has(core)
}

/**
 * The chat's newest offer while a customer can still accept it (`active`) or
 * repeat an acceptance that already ran (`accepted`). Expiry is checked here.
 */
export function openOffer(
  ctx: ActionContext,
  chatId: number,
): OfferRow | undefined {
  const { store } = ctx
  const offer = latestOffer(store, chatId)
  if (!offer || (offer.status !== 'active' && offer.status !== 'accepted'))
    return undefined
  if (Date.parse(offer.expires_at) > store.now().getTime()) return offer
  if (offer.status === 'active') setOfferStatus(store, offer.id, 'expired')
  return undefined
}

/** Section 5.6 (a): only that chat's customer, on the open offer's own button. */
export function callbackOffer(
  ctx: ActionContext,
  event: CallbackEvent,
): OfferRow | undefined {
  const offer = openOffer(ctx, event.chatId)
  return offer &&
    event.data === `offer:${offer.id}` &&
    event.messageId === offer.offer_message_id &&
    event.fromId === offer.chat_id
    ? offer
    : undefined
}

export interface CustomerReply {
  connectionId: string
  /** The accepting messages, ids only (a button press has none). */
  messageIds: number[]
  dateIso?: string
}

export interface Acceptance {
  requestId: string
  response: ActionResponse
  /** False for a replay: nothing ran, so there is nothing to publish. */
  changed: boolean
}

/**
 * Books an accepted offer through the executor's guarantees and confirms it
 * with the `offer_accepted` template. The action row keyed `offer:<offerId>`
 * turns every later acceptance of the same offer into a replay.
 */
export async function acceptOffer(
  ctx: ActionContext,
  offer: OfferRow,
  reply: CustomerReply,
): Promise<Acceptance | undefined> {
  const { store } = ctx
  const key = `offer:${offer.id}`
  const previous = store.db
    .prepare('SELECT * FROM actions WHERE idempotency_key=?')
    .get(key) as unknown as ActionRow | undefined
  if (previous)
    return {
      requestId: previous.request_id,
      response: replay(previous),
      changed: false,
    }
  const request = store.get(offer.request_id)
  if (offer.status !== 'active' || !request) return undefined
  const slot = { startUtc: offer.slot_start_utc, endUtc: offer.slot_end_utc }
  const { action, row, p } = store.transaction(() => {
    setOfferStatus(store, offer.id, 'accepted')
    if (reply.dateIso && reply.messageIds.length)
      store.addMessages(
        request,
        reply.connectionId,
        reply.messageIds,
        reply.dateIso,
      )
    // The accepted slot is now what this customer asked for.
    store.db
      .prepare('UPDATE requests SET requested_start_utc=? WHERE id=?')
      .run(slot.startUtc, request.id)
    store.close(request.id, 'executing')
    const row = store.get(request.id)!
    const p = proposal('offer_accepted', 'Book', slot)
    store.insertProposals(row, [p])
    const id = randomUUID()
    const now = store.now().toISOString()
    store.db
      .prepare(
        `INSERT INTO actions
        (id,request_id,version,action_id,idempotency_key,state,created_at,updated_at)
        VALUES(?,?,?,?,?,'received',?,?)`,
      )
      .run(id, row.id, row.version, p.id, key, now, now)
    const action = store.db
      .prepare('SELECT * FROM actions WHERE id=?')
      .get(id) as unknown as ActionRow
    return { action, row, p }
  })
  const ran = (response: ActionResponse): Acceptance => ({
    requestId: row.id,
    response,
    changed: true,
  })
  if (store.replyBlock(row))
    return ran(
      store.transaction(() =>
        finish(ctx, action, {
          status: 'window_closed',
          card: replaceCard(ctx, row, 'pending', [
            proposal('not_now', 'Not now'),
          ]),
          receipt: 'Cannot reply in Telegram',
        }),
      ),
    )
  const failed = await reserve(ctx, action, row, p)
  return ran(failed ?? (await sendReply(ctx, action, row, p)))
}

/**
 * Startup only: an acceptance cut off before any side effect goes back to the
 * owner as a card for the accepted slot, checked against the calendar again.
 */
export async function reopenAcceptance(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): Promise<void> {
  const { store } = ctx
  const proposals = await planProposals(
    {
      intent: 'book',
      serviceId: row.service_id ?? store.shop.defaultServiceId,
      startUtc: p.slot_start_utc ?? undefined,
      confidence: 1,
      needs: [],
    },
    store.shop,
    ctx.calendar,
    store.now(),
  )
  store.transaction(() => {
    const card = replaceCard(ctx, row, 'pending', proposals)
    finish(
      ctx,
      action,
      {
        status: 'error',
        card,
        receipt: 'Action interrupted before completion',
      },
      'failed',
    )
  })
}
