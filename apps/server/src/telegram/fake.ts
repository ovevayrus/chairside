import { createHash } from 'node:crypto'
import {
  DEFAULT_TIMEOUT_MS,
  EventHub,
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
import type { TelegramEvent } from './events.js'

export type FakeMethod =
  | 'sendText'
  | 'sendWithButton'
  | 'markRead'
  | 'deleteMessages'
  | 'answerCallback'

/** A timeout, a network failure, or a Bot API error code such as 400. */
export type FakeFailure =
  'timeout' | 'network' | { code: number; description?: string }

export interface FakeCall {
  method: FakeMethod
  chatId?: number
  connectionId?: string
  /** SHA-256 (hex) of the outbound text: the fake never keeps the text itself. */
  textSha256?: string
  callbackData?: string
  /** Sends: the id handed back. markRead: the message marked read. */
  messageId?: number
  messageIds?: number[]
  callbackQueryId?: string
  /** Set when an injected failure made the call throw. */
  failed?: 'timeout' | 'network' | number
}

export function textSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** In-memory adapter for tests and TEST MODE: records outbound calls and injects inbound events. */
export class FakeTelegramAdapter implements TelegramAdapter {
  readonly calls: FakeCall[] = []
  readonly #failures: { failure: FakeFailure; method?: FakeMethod }[] = []
  readonly #events: EventHub
  #nextMessageId = 1

  constructor(onError?: TelegramErrorReporter) {
    this.#events = new EventHub(onError)
  }

  /** Makes the next call (of `method`, if given) throw instead of succeeding. */
  failNext(failure: FakeFailure, method?: FakeMethod): void {
    this.#failures.push({ failure, method })
  }

  /** Delivers an inbound event to every handler, as a real update would. */
  emit(event: TelegramEvent): Promise<void> {
    return this.#events.emit(event)
  }

  async sendText(
    chatId: number,
    text: string,
    { connectionId, timeoutMs }: SendOptions = {},
  ): Promise<SendResult> {
    return this.#send(
      {
        method: 'sendText',
        chatId,
        connectionId,
        textSha256: textSha256(text),
      },
      timeoutMs,
    )
  }

  async sendWithButton(
    chatId: number,
    text: string,
    button: InlineButton,
    { connectionId, timeoutMs }: SendOptions = {},
  ): Promise<SendResult> {
    return this.#send(
      {
        method: 'sendWithButton',
        chatId,
        connectionId,
        textSha256: textSha256(text),
        callbackData: button.callbackData,
      },
      timeoutMs,
    )
  }

  async markRead(
    chatId: number,
    messageId: number,
    connectionId: string,
  ): Promise<void> {
    this.#record({ method: 'markRead', chatId, messageId, connectionId })
  }

  async deleteMessages(
    chatId: number,
    messageIds: number[],
    connectionId: string,
  ): Promise<void> {
    this.#record({
      method: 'deleteMessages',
      chatId,
      messageIds: [...messageIds],
      connectionId,
    })
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    this.#record({
      method: 'answerCallback',
      callbackQueryId,
      textSha256: text === undefined ? undefined : textSha256(text),
    })
  }

  onEvent(handler: TelegramEventHandler): () => void {
    return this.#events.on(handler)
  }

  #send(call: FakeCall, timeoutMs?: number): SendResult {
    this.#record(call, timeoutMs)
    call.messageId = this.#nextMessageId++
    return { messageId: call.messageId }
  }

  /** Records the call, then throws the first queued failure that applies to it. */
  #record(call: FakeCall, timeoutMs = DEFAULT_TIMEOUT_MS): void {
    this.calls.push(call)
    const index = this.#failures.findIndex(
      ({ method }) => method === undefined || method === call.method,
    )
    const queued = this.#failures[index]
    if (!queued) return
    this.#failures.splice(index, 1)
    const { failure } = queued
    if (failure === 'timeout') {
      call.failed = 'timeout'
      throw new TelegramTimeoutError(call.method, timeoutMs)
    }
    if (failure === 'network') {
      call.failed = 'network'
      throw new TelegramNetworkError(call.method)
    }
    call.failed = failure.code
    throw new TelegramApiError(
      call.method,
      failure.code,
      failure.description ?? 'Injected failure',
    )
  }
}
