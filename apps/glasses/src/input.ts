import {
  OsEventTypeList,
  pickLoose,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'

export type InputKind =
  | 'click'
  | 'double_click'
  | 'scroll_up'
  | 'scroll_down'
  | 'long_press'
  | 'long_press_release'
  | 'foreground_enter'
  | 'foreground_exit'
  | 'abnormal_exit'
  | 'system_exit'
  | 'imu'
  | 'unknown'

export interface GlassesInput {
  source: 'list' | 'text' | 'sys'
  kind: InputKind
  /** Selected list item (list events only). */
  index?: number
}

const kinds: Record<OsEventTypeList, InputKind> = {
  [OsEventTypeList.CLICK_EVENT]: 'click',
  [OsEventTypeList.SCROLL_TOP_EVENT]: 'scroll_up',
  [OsEventTypeList.SCROLL_BOTTOM_EVENT]: 'scroll_down',
  [OsEventTypeList.DOUBLE_CLICK_EVENT]: 'double_click',
  [OsEventTypeList.FOREGROUND_ENTER_EVENT]: 'foreground_enter',
  [OsEventTypeList.FOREGROUND_EXIT_EVENT]: 'foreground_exit',
  [OsEventTypeList.ABNORMAL_EXIT_EVENT]: 'abnormal_exit',
  [OsEventTypeList.SYSTEM_EXIT_EVENT]: 'system_exit',
  [OsEventTypeList.IMU_DATA_REPORT]: 'imu',
  [OsEventTypeList.LONG_PRESS_EVENT]: 'long_press',
  [OsEventTypeList.LONG_PRESS_RELEASE_EVENT]: 'long_press_release',
}

// Protobuf omits zero values, so CLICK_EVENT (0) arrives with no eventType and
// the first list item arrives with no index. A missing field therefore means
// 0; a field that is present but unknown to this SDK must never become a click.
function kindOf(
  parsed: OsEventTypeList | undefined,
  raw: EvenHubEvent['jsonData'],
): InputKind {
  if (parsed !== undefined) return kinds[parsed]
  return pickLoose(raw, 'eventType') === undefined ? 'click' : 'unknown'
}

/** One envelope per event: list, text or sys. Audio and menu events return null. */
export function normalizeEvent(event: EvenHubEvent): GlassesInput | null {
  if (event.listEvent) {
    return {
      source: 'list',
      kind: kindOf(event.listEvent.eventType, event.jsonData),
      index: event.listEvent.currentSelectItemIndex ?? 0,
    }
  }
  if (event.textEvent) {
    return {
      source: 'text',
      kind: kindOf(event.textEvent.eventType, event.jsonData),
    }
  }
  if (event.sysEvent) {
    return {
      source: 'sys',
      kind: kindOf(event.sysEvent.eventType, event.jsonData),
    }
  }
  return null
}

/** Logs the gestures every screen shares; returns true when the input was one. */
export function logSharedGesture(input: GlassesInput): boolean {
  switch (input.kind) {
    case 'long_press':
      console.log('[chairside] long-press start')
      return true
    case 'long_press_release':
      console.log('[chairside] long-press release')
      return true
    case 'foreground_enter':
    case 'foreground_exit':
    case 'abnormal_exit':
    case 'system_exit':
      console.log(`[chairside] lifecycle ${input.kind}`)
      return true
    default:
      return false
  }
}

/** Root-page double-tap: the system exit dialog (Even Hub QA rule). */
export async function requestExitDialog(
  bridge: Pick<EvenAppBridge, 'shutDownPageContainer'>,
): Promise<void> {
  console.log('[chairside] exit dialog requested')
  try {
    if (!(await bridge.shutDownPageContainer(1))) {
      console.error('[chairside] exit dialog failed')
    }
  } catch (error) {
    console.error('[chairside] exit dialog failed', error)
  }
}
