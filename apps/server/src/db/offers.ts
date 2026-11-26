import type { Interval } from '../slots/engine.js'
import type { RequestStore } from './requests.js'

/**
 * sending → active → accepted, or one of the terminal states. Only `active`
 * can be accepted; `accepted` only replays its stored outcome.
 */
export type OfferStatus =
  | 'sending'
  | 'active'
  | 'accepted'
  | 'superseded'
  | 'answered'
  | 'expired'
  | 'withdrawn'
  | 'failed'
  | 'unknown'

/** Ids, the slot and times only: an offer never keeps message text. */
export interface OfferRow {
  id: string
  request_id: string
  booking_id: string | null
  chat_id: number
  slot_start_utc: string
  slot_end_utc: string
  offer_message_id: number | null
  status: OfferStatus
  expires_at: string
}

/** An offer can be accepted for 2 hours after it was sent, never past its start. */
export const OFFER_TTL_MS = 2 * 60 * 60 * 1000

const ofShop = 'request_id IN (SELECT id FROM requests WHERE shop_id=?)'

/** The chat's newest offer, whatever its status. */
export function latestOffer(
  store: RequestStore,
  chatId: number,
): OfferRow | undefined {
  return store.db
    .prepare(
      `SELECT * FROM offers WHERE chat_id=? AND ${ofShop} ORDER BY rowid DESC LIMIT 1`,
    )
    .get(chatId, store.shopId) as unknown as OfferRow | undefined
}

export function insertOffer(
  store: RequestStore,
  offer: {
    id: string
    requestId: string
    chatId: number
    slot: Interval
    bookingId?: string
  },
): void {
  store.db
    .prepare(
      `INSERT INTO offers (id,request_id,chat_id,slot_start_utc,slot_end_utc,status,expires_at,booking_id)
      VALUES (?,?,?,?,?,'sending',?,?)`,
    )
    .run(
      offer.id,
      offer.requestId,
      offer.chatId,
      offer.slot.startUtc,
      offer.slot.endUtc,
      new Date(store.now().getTime() + OFFER_TTL_MS).toISOString(),
      offer.bookingId ?? null,
    )
}

export function setOfferStatus(
  store: RequestStore,
  id: string,
  status: OfferStatus,
): void {
  store.db
    .prepare(`UPDATE offers SET status=? WHERE id=? AND ${ofShop}`)
    .run(status, id, store.shopId)
}

/**
 * Ends the chat's open offer, for example because the shop wrote again. With
 * message ids, only an offer that was sent as one of those messages ends.
 */
export function endActiveOffers(
  store: RequestStore,
  chatId: number,
  status: Extract<OfferStatus, 'superseded' | 'withdrawn'>,
  messageIds?: number[],
): void {
  const active = store.db
    .prepare(
      `SELECT id,offer_message_id FROM offers WHERE chat_id=? AND status='active' AND ${ofShop}`,
    )
    .all(chatId, store.shopId) as unknown as Pick<
    OfferRow,
    'id' | 'offer_message_id'
  >[]
  for (const { id, offer_message_id: sentAs } of active) {
    if (messageIds && (sentAs === null || !messageIds.includes(sentAs)))
      continue
    setOfferStatus(store, id, status)
  }
}

/** The send succeeded: the offer becomes the chat's single acceptable offer. */
export function activateOffer(
  store: RequestStore,
  id: string,
  messageId: number,
): void {
  const offer = store.db
    .prepare('SELECT chat_id,slot_start_utc FROM offers WHERE id=?')
    .get(id) as unknown as Pick<OfferRow, 'chat_id' | 'slot_start_utc'>
  const expires = Math.min(
    store.now().getTime() + OFFER_TTL_MS,
    Date.parse(offer.slot_start_utc),
  )
  store.transaction(() => {
    endActiveOffers(store, offer.chat_id, 'superseded')
    store.db
      .prepare(
        "UPDATE offers SET status='active',offer_message_id=?,expires_at=? WHERE id=?",
      )
      .run(messageId, new Date(expires).toISOString(), id)
  })
}
