// Shown while the server cannot be reached. Requests wait on the server, so
// nothing is lost; the app resyncs as soon as the link is back.
import {
  CONTENT_WIDTH,
  footer,
  header,
  MARGIN,
  panel,
  type Page,
} from '../ui/layout'
import { MESSAGE_Y } from './receipt'

export interface StatusView {
  test: boolean
  /** Short-lived feedback for a tap, shown in place of the hint. */
  flash?: string
}

export const STATUS_TEXT = 'Reconnecting... requests are queued safely'

export function statusScreen(view: StatusView): Page {
  return {
    screen: 'status',
    boxes: [
      ...header('Chairside', view.test ? 'TEST · OFFLINE' : 'OFFLINE'),
      panel(
        'message',
        ['Reconnecting...', 'Requests are queued safely'],
        { x: MARGIN, y: MESSAGE_Y, width: CONTENT_WIDTH, lines: 2 },
        { capture: true },
      ),
      footer(view.flash ?? 'Tap: retry now  ·  Double-tap: exit'),
    ],
  }
}
