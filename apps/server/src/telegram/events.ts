import type {
  BusinessConnection,
  CallbackQuery,
  Message,
  Update,
} from 'grammy/types'

/** Who wrote a chat message, seen from the owner's business account. */
export type MessageDirection = 'incoming' | 'outgoing_owner' | 'outgoing_bot'

export interface BusinessRights {
  canReply: boolean
  canReadMessages: boolean
  canDeleteSentMessages: boolean
  canDeleteAllMessages: boolean
}

export interface ConnectionEvent {
  type: 'connection'
  updateId: number
  connectionId: string
  ownerUserId: number
  ownerChatId: number
  isEnabled: boolean
  rights: BusinessRights
}

export interface ChatMessageEvent {
  type: 'message' | 'edited'
  updateId: number
  /** Set for business chats; absent for plain chats with the bot (such as the owner's /pair). */
  connectionId?: string
  chatId: number
  messageId: number
  fromId: number
  firstName: string
  /** Text or caption, '' if there is none. In memory only: never persist or log it. */
  text: string
  dateIso: string
  direction: MessageDirection
}

export interface DeletedEvent {
  type: 'deleted'
  updateId: number
  connectionId: string
  chatId: number
  messageIds: number[]
}

export interface CallbackEvent {
  type: 'callback'
  updateId: number
  callbackQueryId: string
  fromId: number
  chatId: number
  messageId: number
  data: string
  connectionId?: string
}

export type TelegramEvent =
  ConnectionEvent | ChatMessageEvent | DeletedEvent | CallbackEvent

export function normalizeConnection(
  connection: BusinessConnection,
): Omit<ConnectionEvent, 'type' | 'updateId'> {
  // grammY's types call the delete right can_delete_outgoing_messages while the plan says
  // can_delete_sent_messages: accept either; the live spike records which name Telegram sends.
  const rights: Record<string, unknown> = { ...connection.rights }
  return {
    connectionId: connection.id,
    ownerUserId: connection.user.id,
    ownerChatId: connection.user_chat_id,
    isEnabled: connection.is_enabled,
    rights: {
      canReply: rights.can_reply === true,
      canReadMessages: rights.can_read_messages === true,
      canDeleteSentMessages:
        rights.can_delete_sent_messages === true ||
        rights.can_delete_outgoing_messages === true,
      canDeleteAllMessages: rights.can_delete_all_messages === true,
    },
  }
}

/** Normalises a Bot API update; returns undefined for updates Chairside does not act on. */
export function toTelegramEvent(
  update: Update,
  ownerUserId: number,
): TelegramEvent | undefined {
  const updateId = update.update_id
  if (update.business_connection) {
    return {
      type: 'connection',
      updateId,
      ...normalizeConnection(update.business_connection),
    }
  }
  const message = update.business_message ?? update.message
  if (message) return chatMessage('message', updateId, message, ownerUserId)
  const edited = update.edited_business_message ?? update.edited_message
  if (edited) return chatMessage('edited', updateId, edited, ownerUserId)
  if (update.deleted_business_messages) {
    const { business_connection_id, chat, message_ids } =
      update.deleted_business_messages
    return {
      type: 'deleted',
      updateId,
      connectionId: business_connection_id,
      chatId: chat.id,
      messageIds: [...message_ids],
    }
  }
  if (update.callback_query) return callback(updateId, update.callback_query)
  return undefined
}

function chatMessage(
  type: ChatMessageEvent['type'],
  updateId: number,
  message: Message,
  ownerUserId: number,
): ChatMessageEvent | undefined {
  const { chat } = message
  // Chairside only serves one-to-one chats.
  if (chat.type !== 'private') return undefined
  return {
    type,
    updateId,
    connectionId: message.business_connection_id,
    chatId: chat.id,
    messageId: message.message_id,
    fromId: message.from?.id ?? chat.id,
    firstName: message.from?.first_name ?? chat.first_name,
    text: message.text ?? message.caption ?? '',
    dateIso: new Date(message.date * 1000).toISOString(),
    direction: directionOf(message, ownerUserId),
  }
}

function directionOf(message: Message, ownerUserId: number): MessageDirection {
  // A plain chat with the bot only ever delivers messages sent to the bot.
  if (message.business_connection_id === undefined) return 'incoming'
  if (message.sender_business_bot) return 'outgoing_bot'
  return message.from?.id === ownerUserId ? 'outgoing_owner' : 'incoming'
}

function callback(
  updateId: number,
  query: CallbackQuery,
): CallbackEvent | undefined {
  const { message, data } = query
  // Inline-mode and game callbacks carry no chat message or no data; Chairside sends neither.
  if (!message || data === undefined) return undefined
  return {
    type: 'callback',
    updateId,
    callbackQueryId: query.id,
    fromId: query.from.id,
    chatId: message.chat.id,
    messageId: message.message_id,
    data,
    connectionId: message.business_connection_id,
  }
}
