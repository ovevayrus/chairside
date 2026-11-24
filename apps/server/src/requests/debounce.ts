import type { ChatMessageEvent } from '../telegram/events.js'

export interface BatchInfo {
  chatId: number
  connectionId: string
  firstName: string
  lastCustomerMsgAt: string
  requestId?: string
  updateId: number
}

interface Pending {
  info: BatchInfo
  messages: Map<number, string>
  timer: ReturnType<typeof setTimeout>
}

export function chatKey(connectionId: string, chatId: number): string {
  return `${connectionId}:${chatId}`
}

/** Bodies live only in this buffer. Its synchronous consumer parses before starting I/O. */
export class ChatDebounce {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly delayMs: number,
    private readonly schedule: (
      work: () => Promise<void>,
      updateId: number,
    ) => void,
    private readonly flush: (
      info: BatchInfo,
      messageIds: number[],
      text: string,
    ) => Promise<void>,
  ) {}

  get(key: string): Readonly<Pending> | undefined {
    return this.pending.get(key)
  }

  push(event: ChatMessageEvent, requestId?: string): void {
    const connectionId = event.connectionId ?? ''
    const key = chatKey(connectionId, event.chatId)
    const previous = this.pending.get(key)
    if (previous) clearTimeout(previous.timer)
    const messages = previous?.messages ?? new Map<number, string>()
    // Updating an item in a Map replaces its body without changing its position.
    messages.set(event.messageId, event.text)
    const priorDate = previous?.info.lastCustomerMsgAt
    const info: BatchInfo = {
      connectionId,
      chatId: event.chatId,
      firstName: event.firstName,
      lastCustomerMsgAt:
        priorDate && priorDate > event.dateIso ? priorDate : event.dateIso,
      requestId: requestId ?? previous?.info.requestId,
      updateId: event.updateId,
    }
    const timer = setTimeout(
      () => this.schedule(() => this.deliver(key, timer), info.updateId),
      this.delayMs,
    )
    this.pending.set(key, { messages, info, timer })
  }

  private deliver(
    key: string,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    const batch = this.pending.get(key)
    if (!batch || batch.timer !== timer) return Promise.resolve()
    this.pending.delete(key)
    const text = Array.from(batch.messages.values()).join(' ')
    const ids = Array.from(batch.messages.keys())
    batch.messages.clear()
    return this.flush(batch.info, ids, text)
  }

  cancel(key: string): void {
    const batch = this.pending.get(key)
    if (!batch) return
    clearTimeout(batch.timer)
    batch.messages.clear()
    this.pending.delete(key)
  }

  close(): void {
    for (const key of this.pending.keys()) this.cancel(key)
  }
}
