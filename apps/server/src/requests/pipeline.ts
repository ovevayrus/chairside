import { DateTime } from 'luxon'
import type { CalendarAdapter } from '../calendar/adapter.js'
import type { RequestRow, RequestStore } from '../db/requests.js'
import type { LiveHub } from '../live/hub.js'
import { parseRequest, type ParseResult } from '../parse/parser.js'
import { parseSchedule } from '../parse/schedule.js'
import {
  reportHandlerError,
  type TelegramAdapter,
} from '../telegram/adapter.js'
import type {
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
}

export function createRequestPipeline(options: PipelineOptions) {
  const { store, calendar, telegram, hub } = options
  const { shopId } = store
  let closed = false

  function upsert(row: RequestRow) {
    hub.broadcast(shopId, { type: 'card.upsert', card: store.card(row) })
  }

  async function persist(
    info: BatchInfo,
    ids: number[],
    parsed: ParseResult & { requestedDayUtc?: string },
  ) {
    const proposals = await planProposals(
      parsed,
      store.shop,
      calendar,
      store.now(),
    )
    if (closed) return
    const row = store.save({
      id: info.requestId,
      chatId: info.chatId,
      firstName: info.firstName,
      parsed,
      lastCustomerMsgAt: info.lastCustomerMsgAt,
      connectionId: info.connectionId,
      messageIds: ids,
      proposals,
    })
    upsert(row)
    await hub.broadcastState(shopId)
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
      const now = store.now()
      const parsed = parseRequest(text, now, store.shop)
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
          : undefined
      return persist(info, ids, { ...parsed, requestedDayUtc })
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
    debounce.push(event, id)
  }

  async function handle(event: TelegramEvent) {
    if (closed) return
    if (event.type === 'connection') {
      if (!store.business || !owns(event) || !store.claim(event.updateId))
        return
      store.setConnection(event)
      for (const row of store.pending()) upsert(row)
      await hub.broadcastState(shopId)
      return
    }
    if (event.type === 'callback') return
    const connectionId = event.connectionId ?? ''
    if (!(await matches(connectionId)) || !store.claim(event.updateId)) return
    const key = chatKey(connectionId, event.chatId)
    if (event.type === 'deleted') return deleted(event, key)
    if (event.direction === 'outgoing_bot' || !event.text.trim()) return
    if (event.direction === 'outgoing_owner') {
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

  const unsubscribe = telegram.onEvent((event) =>
    store.withLock(() => handle(event)),
  )
  return {
    close() {
      closed = true
      unsubscribe()
      debounce.close()
    },
  }
}
