import { setTimeout as delay } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import { createRuntime, type RuntimeOptions } from '../http/runtime.js'
import type { TelegramEventHandler } from '../telegram/adapter.js'
import type { TelegramEvent } from '../telegram/events.js'

function deleteRecords(db: DatabaseSync, shopId: string, chatId?: number) {
  const where = chatId === undefined ? 'shop_id=?' : 'shop_id=? AND chat_id=?'
  const args = chatId === undefined ? [shopId] : [shopId, chatId]
  for (const table of [
    'offers',
    'request_messages',
    'actions',
    'bookings',
    'proposals',
  ]) {
    db.prepare(
      `DELETE FROM ${table} WHERE request_id IN (SELECT id FROM requests WHERE ${where})`,
    ).run(...args)
  }
  db.prepare(`DELETE FROM requests WHERE ${where}`).run(...args)
  if (chatId === undefined) {
    for (const table of ['devices', 'pair_codes', 'consents']) {
      db.prepare(`DELETE FROM ${table} WHERE shop_id=?`).run(shopId)
    }
    db.prepare('DELETE FROM shops WHERE id=?').run(shopId)
  }
}

/** Register privacy commands at the same ingress as bookings, before either can claim an update. */
export function createPrivacyRuntime(
  options: RuntimeOptions,
  ownerCheck: (userId: number) => boolean,
  disconnectDevices?: () => void,
): ReturnType<typeof createRuntime> {
  const { telegram, db, shopId } = options
  const debounceMs = options.debounceMs ?? 2_500
  let incoming = Promise.resolve()
  let shopDeleted = false

  async function dispatch(event: TelegramEvent, book: TelegramEventHandler) {
    if (shopDeleted) return
    if (event.type !== 'message' && event.type !== 'edited') return book(event)
    const command = event.text.trim()
    if (command !== '/forget' && command !== '/delete_my_data')
      return book(event)
    if (
      event.type !== 'message' ||
      event.direction !== 'incoming' ||
      event.connectionId !== undefined ||
      event.fromId !== event.chatId
    )
      return

    const { store } = runtime
    const owner = ownerCheck(event.fromId)
    const forget = command === '/forget'
    if (forget ? store.business || owner : !owner) return
    if (forget) {
      // All earlier inbound events have reached the pipeline. Let its last
      // scheduled batch reach the store lock before deleting this chat.
      await delay(debounceMs)
    }
    const erased = await store.withLock(async () => {
      const firstDelivery = store.transaction(() => {
        if (!store.claim(event.updateId)) return false
        deleteRecords(db, shopId, forget ? event.chatId : undefined)
        return true
      })
      // Stop collecting against a deleted shop, including outstanding timers.
      if (firstDelivery && !forget) {
        shopDeleted = true
        runtime.pipeline.close()
        disconnectDevices?.()
      }
      return firstDelivery
    })
    if (erased) {
      await Promise.all([
        telegram.sendText(
          event.chatId,
          forget
            ? 'Your booking data was deleted.'
            : 'Your shop data was deleted.',
        ),
        forget && runtime.hub.broadcastState(shopId),
      ])
    }
  }

  const runtime = createRuntime({
    ...options,
    debounceMs,
    telegram: {
      sendText: telegram.sendText.bind(telegram),
      sendWithButton: telegram.sendWithButton.bind(telegram),
      markRead: telegram.markRead.bind(telegram),
      deleteMessages: telegram.deleteMessages.bind(telegram),
      answerCallback: telegram.answerCallback.bind(telegram),
      onEvent: (book) =>
        telegram.onEvent((event) => {
          // Preserve Telegram order even for concurrently injected updates. New
          // bookings must wait until a preceding deletion has finished.
          const work = incoming.then(() => dispatch(event, book))
          incoming = work.catch(() => {})
          return work
        }),
    },
  })
  return runtime
}
