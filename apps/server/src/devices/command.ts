import type { TelegramAdapter } from '../telegram/adapter.js'
import type { TelegramEvent } from '../telegram/events.js'
import {
  CODE_ALPHABET,
  PAIR_ATTEMPTS_PER_MINUTE,
  type PairingService,
} from './pairing.js'

const PAIR_COMMAND = /^\/pair(?:@\w+)?(?:\s+(\S{1,32}))?$/i
const WINDOW_MS = 60_000

export interface PairCommandOptions {
  pairing: PairingService
  telegram: Pick<TelegramAdapter, 'sendText'>
  /** True for the configured owner or the stored business-connection owner. */
  isOwner: (userId: number) => boolean
  now?: () => Date
  /** Receives only the last 2 characters of a code. */
  log?: (message: string, codeSuffix: string) => void
}

/** Handles the owner's `/pair CODE` in the bot's own chat; subscribe it with `telegram.onEvent`. */
export function createPairCommandHandler(options: PairCommandOptions) {
  const { pairing, telegram, isOwner, log } = options
  const now = options.now ?? (() => new Date())
  const attempts = new Map<number, number[]>()

  function limited(chatId: number): boolean {
    const time = now().getTime()
    const recent = (attempts.get(chatId) ?? []).filter(
      (at) => time - at < WINDOW_MS,
    )
    const over = recent.length >= PAIR_ATTEMPTS_PER_MINUTE
    if (!over) recent.push(time)
    attempts.set(chatId, recent)
    return over
  }

  return async (event: TelegramEvent): Promise<void> => {
    if (
      event.type !== 'message' ||
      event.direction !== 'incoming' ||
      event.connectionId
    )
      return
    const match = PAIR_COMMAND.exec(event.text.trim())
    if (!match) return
    if (limited(event.chatId)) return
    // Strangers get no answer, so the bot does not confirm the command exists.
    if (!isOwner(event.fromId)) return
    const code = (match[1] ?? '').toUpperCase()
    const valid =
      code.length > 0 && [...code].every((ch) => CODE_ALPHABET.includes(ch))
    const bound = valid && pairing.bind(code)
    log?.(bound ? 'device paired' : 'pair code rejected', code.slice(-2))
    await telegram.sendText(
      event.chatId,
      bound ? 'Glasses paired' : 'Code expired or wrong',
    )
  }
}
