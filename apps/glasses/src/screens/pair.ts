// First run: how to pair, with the 6-character code large in its own box.
// The owner sends "/pair CODE" to the shop's bot; the glasses then receive
// their device token once and never show this screen again.
import {
  footer,
  header,
  MARGIN,
  panel,
  SCREEN_WIDTH,
  textLines,
  CONTENT_WIDTH,
  type Page,
} from '../ui/layout'

export interface PairView {
  test: boolean
  /** The code, once the server issued one. */
  code?: string
  /** Whole minutes left (0 = under a minute). */
  minutesLeft?: number
  expired?: boolean
  /** The server could not be reached or refused. */
  offline?: boolean
  /** Bot username without "@", when the build knows it. */
  bot?: string
  flash?: string
}

const STEPS_Y = 40
const CODE_WIDTH = 300
const CODE_Y = 104
const EXPIRY_Y = 166

export function expiryLine(view: PairView): string {
  if (view.offline) return "Can't reach the Chairside server · retrying"
  if (view.expired) return 'Code expired · tap for a new code'
  if (!view.code || view.minutesLeft === undefined) return ' '
  return view.minutesLeft >= 1
    ? `Code expires in ${view.minutesLeft} min`
    : 'Code expires in under a minute'
}

export function pairScreen(view: PairView): Page {
  const bot = view.bot ? `@${view.bot}` : 'your Chairside bot'
  return {
    screen: 'pair',
    boxes: [
      ...header('Pair Chairside', view.test ? 'TEST' : ''),
      textLines('steps', [`1. Open Telegram ▶ ${bot}`, '2. Send:'], {
        x: MARGIN,
        y: STEPS_Y,
        width: CONTENT_WIDTH,
      }),
      panel(
        'code',
        [view.code ? `/pair ${view.code}` : 'Getting a code...'],
        {
          x: (SCREEN_WIDTH - CODE_WIDTH) / 2,
          y: CODE_Y,
          width: CODE_WIDTH,
          lines: 1,
        },
        { capture: true, center: true },
      ),
      textLines('expiry', [view.flash ?? expiryLine(view)], {
        x: MARGIN,
        y: EXPIRY_Y,
        width: CONTENT_WIDTH,
      }),
      footer(
        view.expired || view.offline
          ? 'Tap: new code  ·  Double-tap: exit'
          : 'Double-tap: exit',
      ),
    ],
  }
}
