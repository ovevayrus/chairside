import { Bot, GrammyError, HttpError } from 'grammy'
import type { BotFullInfo, Update } from 'grammy/types'
import {
  DEFAULT_TIMEOUT_MS,
  EventHub,
  reportHandlerError,
  TelegramApiError,
  TelegramNetworkError,
  TelegramTimeoutError,
  type InlineButton,
  type SendOptions,
  type SendResult,
  type TelegramAdapter,
  type TelegramErrorReporter,
  type TelegramEventHandler,
} from './adapter.js'
import { toTelegramEvent } from './events.js'

export type UpdateType = Exclude<keyof Update, 'update_id'>

// grammY's Node typings declare the abort-controller polyfill's AbortSignal. grammY only
// calls aborted/addEventListener/removeEventListener on it, which Node's own signal provides.
type ApiSignal = NonNullable<Parameters<Bot['api']['sendMessage']>[3]>

export interface GrammyAdapterOptions {
  token: string
  /** OWNER_TELEGRAM_USER_ID: tells the owner's own replies apart from customer messages. */
  ownerUserId: number
  /** Known bot info (tests), so grammY never has to call getMe. */
  botInfo?: BotFullInfo
  /** Receives handler failures. Defaults to a console line with ids only. */
  onError?: TelegramErrorReporter
}

/** grammY plumbing shared by the business and shop-bot adapters. */
export abstract class GrammyAdapter implements TelegramAdapter {
  readonly bot: Bot
  readonly allowedUpdates: readonly UpdateType[]
  readonly #events: EventHub

  protected constructor(
    options: GrammyAdapterOptions,
    allowedUpdates: readonly UpdateType[],
  ) {
    const report = options.onError ?? reportHandlerError
    this.bot = new Bot(options.token, { botInfo: options.botInfo })
    this.allowedUpdates = allowedUpdates
    this.#events = new EventHub(report)
    this.bot.use(async (ctx, next) => {
      const event = toTelegramEvent(ctx.update, options.ownerUserId)
      if (event) await this.#events.emit(event)
      await next()
    })
    // grammY's default error handler stops long polling; report and keep going instead.
    this.bot.catch(({ error, ctx }) => report(error, ctx.update.update_id))
  }

  abstract sendText(
    chatId: number,
    text: string,
    opts?: SendOptions,
  ): Promise<SendResult>
  abstract sendWithButton(
    chatId: number,
    text: string,
    button: InlineButton,
    opts?: SendOptions,
  ): Promise<SendResult>
  abstract markRead(
    chatId: number,
    messageId: number,
    connectionId: string,
  ): Promise<void>
  abstract deleteMessages(
    chatId: number,
    messageIds: number[],
    connectionId: string,
  ): Promise<void>

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.answerCallbackQuery(callbackQueryId, { text }, signal),
    )
  }

  async setProfileDescriptions(
    description: string,
    shortDescription: string,
  ): Promise<void> {
    await this.call('setMyDescription', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.setMyDescription(description, {}, signal),
    )
    await this.call('setMyShortDescription', DEFAULT_TIMEOUT_MS, (signal) =>
      this.bot.api.setMyShortDescription(shortDescription, {}, signal),
    )
  }

  onEvent(handler: TelegramEventHandler): () => void {
    return this.#events.on(handler)
  }

  /**
   * Long-polls with this mode's allowed_updates until stop(). The promise rejects on a
   * fatal error such as a revoked token (401) or a second poller (409).
   */
  start(onStart?: () => void): Promise<void> {
    return this.bot.start({
      allowed_updates: this.allowedUpdates,
      onStart: () => onStart?.(),
    })
  }

  stop(): Promise<void> {
    return this.bot.stop()
  }

  protected async sendMessage(
    chatId: number,
    text: string,
    {
      connectionId,
      button,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    }: SendOptions & { button?: InlineButton },
  ): Promise<SendResult> {
    const message = await this.call('sendMessage', timeoutMs, (signal) =>
      this.bot.api.sendMessage(
        chatId,
        text,
        {
          business_connection_id: connectionId,
          reply_markup: button && {
            inline_keyboard: [
              [{ text: button.text, callback_data: button.callbackData }],
            ],
          },
        },
        signal,
      ),
    )
    return { messageId: message.message_id }
  }

  /** One Bot API call with a hard timeout and no retry, mapped to the adapter's errors. */
  protected async call<T>(
    method: string,
    timeoutMs: number,
    request: (signal: ApiSignal) => Promise<T>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      return await request(signal as unknown as ApiSignal)
    } catch (error) {
      // A GrammyError keeps the request payload, message text included: pass on only the code.
      if (error instanceof GrammyError) {
        throw new TelegramApiError(method, error.error_code, error.description)
      }
      if (signal.aborted) throw new TelegramTimeoutError(method, timeoutMs)
      if (error instanceof HttpError) throw new TelegramNetworkError(method)
      throw error
    }
  }
}
