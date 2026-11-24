// One request at a time: dim header (what it is, TEST, position in the queue),
// up to three bright lines (who, what, when) and the actions as a firmware
// list. The smart default is the server's first action, so the highlight
// starts on it; a tap runs the highlighted action.
import type { Card } from '../net/protocol'
import {
  clean,
  CONTENT_WIDTH,
  fitBlock,
  fitLine,
  footer,
  header,
  LINE_HEIGHT,
  LIST_ITEM_HEIGHT,
  LIST_ITEM_INSET,
  MARGIN,
  SCREEN_WIDTH,
  type Page,
} from '../ui/layout'

export interface CardView {
  card: Card
  /** 1-based position of this card among the pending ones, and their count. */
  position: number
  total: number
  test: boolean
  /**
   * Replaces the header: progress ("Sending · Book & reply", dim, updated in
   * place) or the outcome of a tap ("Just taken · nothing sent", bright).
   */
  note?: { text: string; alert: boolean }
}

const BODY_Y = 36
const MAX_LINES = 3
export const CARD_HINT = 'Swipe: move  ·  Tap: select  ·  Double-tap: back'

export function cardMeta(view: Pick<CardView, 'position' | 'total' | 'test'>) {
  const position = view.total > 1 ? `${view.position}/${view.total}` : ''
  return [view.test ? 'TEST' : '', position].filter(Boolean).join(' · ')
}

export function cardScreen(view: CardView): Page {
  const { card } = view
  const lines = fitBlock(
    card.lines.map(clean).filter(Boolean),
    CONTENT_WIDTH,
    MAX_LINES,
  )
  const bodyHeight = Math.max(lines.length, 1) * LINE_HEIGHT
  const items = card.actions.map(
    (action) =>
      fitLine(clean(action.label), SCREEN_WIDTH - 2 * LIST_ITEM_INSET) ||
      'Action',
  )
  const listY = BODY_Y + bodyHeight + 8
  const hint = footer(CARD_HINT)
  const roomForHint = listY + items.length * LIST_ITEM_HEIGHT + 4 <= hint.y
  return {
    screen: 'card',
    boxes: [
      ...header(view.note?.text ?? card.header, cardMeta(view), {
        bright: view.note?.alert,
      }),
      {
        kind: 'text',
        name: 'body',
        x: MARGIN,
        y: BODY_Y,
        width: CONTENT_WIDTH,
        height: bodyHeight,
        content: lines.join('\n') || ' ',
      },
      {
        kind: 'list',
        name: 'actions',
        x: 0,
        y: listY,
        width: SCREEN_WIDTH,
        height: items.length * LIST_ITEM_HEIGHT,
        items,
        capture: true,
      },
      // The gestures, when the actions leave room for them.
      ...(roomForHint ? [hint] : []),
    ],
  }
}
