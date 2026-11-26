import { DateTime } from 'luxon'
import { publish, type ActionContext } from '../actions/context.js'
import {
  acceptOffer,
  callbackOffer,
  isAcceptance,
  openOffer,
} from '../actions/offers.js'
import type { CalendarAdapter } from '../calendar/adapter.js'
import { upcomingBookings, type BookingRow } from '../db/bookings.js'
import { endActiveOffers, setOfferStatus, type OfferRow } from '../db/offers.js'
import type { RequestRow, RequestStore } from '../db/requests.js'
import type { LiveHub } from '../live/hub.js'
import { parseRequest, type ParseResult } from '../parse/parser.js'
import { parseSchedule } from '../parse/schedule.js'
import {
  reportHandlerError,
  type TelegramAdapter,
} from '../telegram/adapter.js'
import type {
  CallbackEvent,
  ChatMessageEvent,
  ConnectionEvent,
  DeletedEvent,
  TelegramEvent,
} from '../telegram/events.js'
import { planProposals } from './cards.js'
import { chatKey, ChatDebounce, type BatchInfo } from './debounce.js'

type Connection = Omit<ConnectionEvent, 'type' | 'updateId'>

export interface PipelineOptions {
  store: RequestStore
  calendar: CalendarAdapter
  telegram: TelegramAdapter
  hub: LiveHub
  ownerUserId?: number
  getConnection?: (connectionId: string) => Promise<Connection>
  debounceMs?: number
  /** CALLBACKS_SUPPORTED: offers carry a `Book <time>` button. */
  callbacksSupported?: boolean
  checkpoint?: ActionContext['checkpoint']
}

export function createRequestPipeline(options: PipelineOptions) {
  const { store, calendar, telegram, hub } = options
  const { shopId } = store
  // Offer acceptance books through the executor's guarantees.
  const ctx: ActionContext = {
    store,
    calendar,
    telegram,
    hub,
    callbacksSupported: options.callbacksSupported ?? false,
    checkpoint: options.checkpoint,
  }
  let closed = false

  function upsert(row: RequestRow) {
    hub.broadcast(shopId, { type: 'card.upsert', card: store.card(row) })
  }

  async function persist(
    info: BatchInfo,
    ids: number[],
    parsed: ParseResult,
    booking?: BookingRow,
  ) {
    const proposals = await planProposals(
      parsed,
      store.shop,
      calendar,
      store.now(),
      [],
      booking,
    )
    if (closed) return
    const row = store.save({
      id: info.requestId,
      chatId: info.chatId,
      firstName: info.firstName,
      parsed,
      bookingId: booking?.id,
      lastCustomerMsgAt: info.lastCustomerMsgAt,
      connectionId: info.connectionId,
      messageIds: ids,
      proposals,
    })
    upsert(row)
    await hub.broadcastState(shopId)
  }

  async function accept(info: BatchInfo, ids: number[], offer: OfferRow) {
    // A pending request this batch began to update stays as it was.
    if (info.requestId) store.cancelUpdate(info.requestId)
    const outcome = await acceptOffer(ctx, offer, {
      connectionId: info.connectionId,
      messageIds: ids,
      dateIso: info.lastCustomerMsgAt,
    })
    if (outcome?.changed)
      await publish(
        ctx,
        outcome.requestId,
        outcome.response,
        outcome.idempotencyKey,
      )
    else await hub.broadcastState(shopId)
  }

  const debounce = new ChatDebounce(
    options.debounceMs ?? 2_500,
    (work, updateId) => {
      void store
        .withLock(work)
        .catch((e: unknown) => reportHandlerError(e, updateId))
    },
    // Parse synchronously. Only structured values cross the calendar await.
    (info, ids, text) => {
      // Only the offer open before this batch began can be accepted, and only
      // by a whole whitelisted reply. Any other reply ends the offer.
      const offer = info.offerId ? openOffer(ctx, info.chatId) : undefined
      if (offer && offer.id === info.offerId) {
        if (isAcceptance(text)) return accept(info, ids, offer)
        if (offer.status === 'active')
          setOfferStatus(store, offer.id, 'answered')
      }
      const now = store.now()
      const bookings = upcomingBookings(store, info.chatId)
      const parsed = parseRequest(text, now, store.shop, bookings)
      const requestedDayUtc =
        parsed.intent === 'book' &&
        parsed.needs.includes('time') &&
        !parsed.needs.includes('date')
          ? parseSchedule(
              `${text} at noon`,
              DateTime.fromJSDate(now, { zone: store.shop.timezone }),
              store.shop,
              true,
            ).startUtc
          : parsed.requestedDayUtc
      const booking = bookings.find(({ id }) => id === parsed.bookingId)
      return persist(info, ids, { ...parsed, requestedDayUtc }, booking)
    },
  )

  function owns(connection: Connection) {
    const owner = options.ownerUserId ?? store.connection().ownerId
    return owner == null || owner === connection.ownerUserId
  }

  async function matches(connectionId: string) {
    if (!store.business) return connectionId === ''
    if (!connectionId) return false
    const known = store.connection().id
    if (known) return known === connectionId
    if (!options.getConnection) return false
    const connection = await options.getConnection(connectionId)
    if (connection.connectionId !== connectionId || !owns(connection))
      return false
    store.setConnection(connection)
    return true
  }

  function editable(row?: RequestRow) {
    return row?.status === 'pending' || row?.status === 'updating'
  }

  function visible(chatId: number, connectionId: string) {
    return store
      .pending(chatId)
      .filter((r) => store.lastMessage(r.id)?.connection_id === connectionId)
  }

  async function remove(ids: Set<string>, status: string) {
    for (const id of ids) {
      store.close(id, status)
      hub.broadcast(shopId, { type: 'card.remove', requestId: id })
    }
    if (ids.size) await hub.broadcastState(shopId)
  }

  async function deleted(event: DeletedEvent, key: string) {
    const batch = debounce.get(key)
    const ids = new Set<string>()
    for (const messageId of event.messageIds) {
      const row = store.forMessage(event.connectionId, event.chatId, messageId)
      if (row && editable(row)) ids.add(row.id)
    }
    if (
      batch &&
      (event.messageIds.some((id) => batch.messages.has(id)) ||
        (batch.info.requestId && ids.has(batch.info.requestId)))
    ) {
      if (batch.info.requestId) ids.add(batch.info.requestId)
      debounce.cancel(key)
    }
    await remove(ids, 'deleted')
  }

  function incoming(
    event: ChatMessageEvent,
    connectionId: string,
    key: string,
  ) {
    const batch = debounce.get(key)
    const source =
      event.type === 'edited'
        ? store.forMessage(connectionId, event.chatId, event.messageId)
        : undefined
    // An edit to a completed, deleted, or unrelated message cannot revive an appointment.
    if (
      event.type === 'edited' &&
      !editable(source) &&
      !batch?.messages.has(event.messageId)
    )
      return
    const id =
      batch?.info.requestId ??
      source?.id ??
      visible(event.chatId, connectionId).find(editable)?.id
    if (id && !batch) store.beginUpdate(id)
    const offerId =
      event.type === 'message' && !batch
        ? openOffer(ctx, event.chatId)?.id
        : undefined
    debounce.push(event, id, offerId)
  }

  async function handle(event: Exclude<TelegramEvent, CallbackEvent>) {
    if (closed) return
    if (event.type === 'connection') {
      if (!store.business || !owns(event) || !store.claim(event.updateId))
        return
      store.setConnection(event)
      for (const row of store.pending()) upsert(row)
      await hub.broadcastState(shopId)
      return
    }
    const connectionId = event.connectionId ?? ''
    if (!(await matches(connectionId)) || !store.claim(event.updateId)) return
    const key = chatKey(connectionId, event.chatId)
    if (event.type === 'deleted') {
      // A deleted offer message can no longer be accepted.
      endActiveOffers(store, event.chatId, 'withdrawn', event.messageIds)
      return deleted(event, key)
    }
    if (event.direction === 'outgoing_bot' || !event.text.trim()) return
    if (event.direction === 'outgoing_owner') {
      // The owner wrote by hand: a later "yes" may answer that, not the offer.
      endActiveOffers(store, event.chatId, 'superseded')
      const ids = new Set(
        visible(event.chatId, connectionId).map((row) => row.id),
      )
      const editing = debounce.get(key)?.info.requestId
      if (editing) ids.add(editing)
      debounce.cancel(key)
      return remove(ids, 'handled_elsewhere')
    }
    if (event.fromId === (options.ownerUserId ?? store.connection().ownerId))
      return
    incoming(event, connectionId, key)
  }

  /** Section 5.6 (a). Every press is answered, outside the lock; only the right one books. */
  async function callback(event: CallbackEvent) {
    let accepted = false
    try {
      accepted = await store.withLock(async () => {
        if (closed || !ctx.callbacksSupported) return false
        const connectionId = event.connectionId ?? ''
        if (!(await matches(connectionId)) || !store.claim(event.updateId))
          return false
        const offer = callbackOffer(ctx, event)
        const outcome =
          offer &&
          (await acceptOffer(ctx, offer, { connectionId, messageIds: [] }))
        if (!outcome) return false
        if (outcome.changed)
          await publish(
            ctx,
            outcome.requestId,
            outcome.response,
            outcome.idempotencyKey,
          )
        return true
      })
    } finally {
      await telegram
        .answerCallback(
          event.callbackQueryId,
          accepted ? undefined : 'This offer is not available',
        )
        .catch(() => {})
    }
  }

  const unsubscribe = telegram.onEvent((event) =>
    event.type === 'callback'
      ? callback(event)
      : store.withLock(() => handle(event)),
  )
  return {
    close() {
      closed = true
      unsubscribe()
      debounce.close()
    },
  }
}
