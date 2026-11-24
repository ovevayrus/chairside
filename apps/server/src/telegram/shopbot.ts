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

/** Telegram reports no deletions in plain bot chats, so there is nothing more to receive. */
export const SHOPBOT_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
] as const satisfies readonly UpdateType[]

/**
 * Fallback without Telegram Business (only after the user approves the pivot): customers
 * write to the bot itself. Plain bot chats have no connection, so connectionId is ignored.
 */
export class ShopBotTelegramAdapter extends GrammyAdapter {
  constructor(options: GrammyAdapterOptions) {
    super(options, SHOPBOT_ALLOWED_UPDATES)
  }

  sendText(
    chatId: number,
    text: string,
    { timeoutMs }: SendOptions = {},
  ): Promise<SendResult> {
    return this.sendMessage(chatId, text, { timeoutMs })
  }

  sendWithButton(
    chatId: number,
    text: string,
    button: InlineButton,
    { timeoutMs }: SendOptions = {},
  ): Promise<SendResult> {
    return this.sendMessage(chatId, text, { button, timeoutMs })
  }

  /** Bots cannot mark messages read in their own chats. */
  async markRead(): Promise<void> {}

  async deleteMessages(chatId: number, messageIds: number[]): Promise<void> {
    await this.call('deleteMessages', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.deleteMessages(chatId, messageIds, signal),
    )
  }
}
