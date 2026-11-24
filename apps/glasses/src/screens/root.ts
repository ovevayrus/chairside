// Root: today at a glance. Next and Then come from the shop calendar (server
// RootState), the panel says how many requests wait, and the footer names the
// gestures. Tap opens the first card; double-tap asks to exit.
import type { RootState } from '../net/protocol'
import {
  clean,
  footer,
  header,
  LINE_HEIGHT,
  MARGIN,
  panel,
  SCREEN_WIDTH,
  textLines,
  CONTENT_WIDTH,
  DIM,
  type Page,
} from '../ui/layout'

export interface RootView {
  /** Undefined until the first state arrives. */
  root?: RootState
  pending: number
  test: boolean
  /** Today's weekday and date on the device, e.g. "Tue 24 Nov". */
  date: string
  /** "14:35" while new cards are paused. */
  pausedUntil?: string
  /** Short-lived feedback for a gesture, shown in the panel. */
  flash?: string
  calendarError?: boolean
}

const LABEL_WIDTH = 76
const AGENDA_Y = 40
const PANEL_Y = AGENDA_Y + 2 * LINE_HEIGHT + 22

function slot(entry: RootState['next']): string {
  if (!entry) return ''
  const who = [clean(entry.name), clean(entry.service)]
    .filter(Boolean)
    .join(' · ')
  return `${entry.time}  ${who || 'Busy'}`
}

export function rootMeta(view: Pick<RootView, 'test' | 'date'>) {
  return [view.test ? 'TEST' : '', view.date].filter(Boolean).join(' · ')
}

export function pendingLine(view: RootView): string {
  if (view.flash) return view.flash
  const waiting =
    view.pending === 1
      ? '1 request waiting'
      : `${view.pending} requests waiting`
  if (view.pausedUntil)
    return `■ Cards paused until ${view.pausedUntil} · ${view.pending} waiting`
  return view.pending > 0
    ? `● ${waiting} · tap to open`
    : '○ No requests waiting'
}

export function rootScreen(view: RootView): Page {
  const { root } = view
  let labels: string[]
  let agenda: string[]
  if (!root) {
    labels = ['', '']
    agenda = ['Connecting to your front desk...', '']
  } else if (view.calendarError && !root.next) {
    labels = ['Next', '']
    agenda = ['Calendar unavailable', '']
  } else if (!root.next) {
    labels = ['Today', '']
    agenda = ['No more appointments', '']
  } else {
    labels = ['Next', root.then ? 'Then' : '']
    agenda = [slot(root.next), slot(root.then)]
  }
  return {
    screen: 'root',
    boxes: [
      ...header(root ? root.shopName : 'Chairside', rootMeta(view)),
      textLines(
        'labels',
        labels,
        { x: MARGIN, y: AGENDA_Y, width: LABEL_WIDTH },
        { brightness: DIM },
      ),
      textLines(
        'agenda',
        agenda,
        {
          x: MARGIN + LABEL_WIDTH + 8,
          y: AGENDA_Y,
          width: SCREEN_WIDTH - 2 * MARGIN - LABEL_WIDTH - 8,
        },
        { capture: true },
      ),
      panel('pending', [pendingLine(view)], {
        x: MARGIN,
        y: PANEL_Y,
        width: CONTENT_WIDTH,
        lines: 1,
      }),
      footer('Tap: open  ·  Swipe: refresh  ·  Double-tap: exit'),
    ],
  }
}
