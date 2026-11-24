// What just happened, for two seconds: "● Booked Sat 28 Nov 15:00" and who it
// was for. Then the app moves on by itself (a tap moves on at once).
import {
  CONTENT_WIDTH,
  footer,
  header,
  MARGIN,
  panel,
  type Page,
} from '../ui/layout'

export interface ReceiptView {
  title: string
  text: string
  detail?: string
  /** Where the app goes next, e.g. "Next request in 2 s". */
  hint: string
  test: boolean
}

/** Receipt and status share one layout, so switching between them never flickers. */
export const MESSAGE_Y = 44

export function receiptScreen(view: ReceiptView): Page {
  return {
    screen: 'receipt',
    boxes: [
      ...header(view.title, view.test ? 'TEST' : ''),
      panel(
        'message',
        [view.text, view.detail ?? ''],
        { x: MARGIN, y: MESSAGE_Y, width: CONTENT_WIDTH, lines: 2 },
        { capture: true },
      ),
      footer(view.hint),
    ],
  }
}
