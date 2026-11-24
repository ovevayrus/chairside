import type { TelegramEvent } from './events.js'

/** HTTP timeout for every Bot API call Chairside makes, sends included. */
export const DEFAULT_TIMEOUT_MS = 8_000

export interface SendResult {
  messageId: number
}

export interface SendOptions {
  /** Business connection to send through; omit for a plain chat with the bot. */
  connectionId?: string
  /** Aborts the HTTP call after this many ms (default 8000). Sends are never retried. */
  timeoutMs?: number
}

export interface InlineButton {
  text: string
  callbackData: string
}

export type TelegramEventHandler = (
  event: TelegramEvent,
) => void | Promise<void>

/** Receives a failing handler's error with the update id; never the message text. */
export type TelegramErrorReporter = (error: unknown, updateId: number) => void

export interface TelegramAdapter {
  sendText(
    chatId: number,
    text: string,
    opts?: SendOptions,
  ): Promise<SendResult>
  sendWithButton(
    chatId: number,
    text: string,
    button: InlineButton,
    opts?: SendOptions,
  ): Promise<SendResult>
  markRead(
    chatId: number,
    messageId: number,
    connectionId: string,
  ): Promise<void>
  deleteMessages(
    chatId: number,
    messageIds: number[],
    connectionId: string,
  ): Promise<void>
  answerCallback(callbackQueryId: string, text?: string): Promise<void>
  /** Subscribes to inbound events; returns the unsubscribe function. */
  onEvent(handler: TelegramEventHandler): () => void
}

/** No answer within timeoutMs, so whether Telegram acted is unknown. */
export class TelegramTimeoutError extends Error {
  override readonly name = 'TelegramTimeoutError'
  readonly method: string
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`Telegram ${method} timed out after ${timeoutMs} ms`)
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

/**
 * The request failed before Telegram answered (DNS, refused or reset connection), so whether
 * Telegram acted is unknown. Carries no cause: the underlying error's message holds the URL,
 * and with it the bot token.
 */
export class TelegramNetworkError extends Error {
  override readonly name = 'TelegramNetworkError'
  readonly method: string

  constructor(method: string) {
    super(`Telegram ${method} failed before Telegram answered`)
    this.method = method
  }
}

/** Telegram answered with an error code; a 4xx means the call definitely did not happen. */
export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError'
  readonly method: string
  readonly code: number
  readonly description: string

  constructor(method: string, code: number, description: string) {
    super(`Telegram ${method} failed with ${code}: ${description}`)
    this.method = method
    this.code = code
    this.description = description
  }
}

/** Logs the update id and the error's name only: either message could quote customer text. */
export function reportHandlerError(error: unknown, updateId: number): void {
  const name = error instanceof Error ? error.name : typeof error
  console.error(`[telegram] handler failed for update ${updateId}: ${name}`)
}

/** Fans inbound events out to subscribers; a failing handler never stops the others. */
export class EventHub {
  readonly #handlers = new Set<TelegramEventHandler>()
  readonly #report: TelegramErrorReporter

  constructor(report: TelegramErrorReporter = reportHandlerError) {
    this.#report = report
  }

  on(handler: TelegramEventHandler): () => void {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  async emit(event: TelegramEvent): Promise<void> {
    for (const handler of [...this.#handlers]) {
      try {
        await handler(event)
      } catch (error) {
        this.#report(error, event.updateId)
      }
    }
  }
}
