import type { BusinessConnection } from 'grammy/types'
import {
  DEFAULT_TIMEOUT_MS,
  type InlineButton,
  type SendOptions,
  type SendResult,
} from './adapter.js'
import {
  GrammyAdapter,
  type GrammyAdapterOptions,
  type UpdateType,
} from './grammy.js'

/** Updates the business mode subscribes to, for long polling now and setWebhook later. */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const satisfies readonly UpdateType[]

/** Replies from the owner's own account through a Telegram Business connection. */
export class BusinessTelegramAdapter extends GrammyAdapter {
  constructor(options: GrammyAdapterOptions) {
    super(options, ALLOWED_UPDATES)
  }

  sendText(
    chatId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    return this.sendMessage(chatId, text, opts)
  }

  sendWithButton(
    chatId: number,
    text: string,
    button: InlineButton,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    return this.sendMessage(chatId, text, { ...opts, button })
  }

  /** Needs the can_read_messages right. */
  async markRead(
    chatId: number,
    messageId: number,
    connectionId: string,
  ): Promise<void> {
    await this.call('readBusinessMessage', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.readBusinessMessage(connectionId, chatId, messageId, signal),
    )
  }

  /** Needs the delete-sent-messages right; Telegram takes the chat from the ids. */
  async deleteMessages(
    _chatId: number,
    messageIds: number[],
    connectionId: string,
  ): Promise<void> {
    await this.call('deleteBusinessMessages', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.deleteBusinessMessages(connectionId, messageIds, signal),
    )
  }

  /**
   * The connection as Telegram reports it now (raw, for normalizeConnection). Needed after
   * a cold start: the business_connection update only arrives when the owner changes it.
   */
  getConnection(connectionId: string): Promise<BusinessConnection> {
    return this.call('getBusinessConnection', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.getBusinessConnection(connectionId, signal),
    )
  }
}
