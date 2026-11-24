import { evenHubEventFromJson } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import { normalizeEvent } from '../src/input'

// Host-shaped payloads go through the SDK's own parser, as on the glasses.
function input(type: string, jsonData: Record<string, unknown>) {
  return normalizeEvent(evenHubEventFromJson({ type, jsonData }))
}

describe('normalizeEvent', () => {
  it('reads a click on the first list item when protobuf omits eventType and index', () => {
    expect(
      input('listEvent', { containerID: 2, containerName: 'actions' }),
    ).toEqual({
      source: 'list',
      kind: 'click',
      index: 0,
    })
  })

  it('reads the selected list index', () => {
    expect(
      input('listEvent', {
        containerID: 2,
        currentSelectItemIndex: 2,
        eventType: 0,
      }),
    ).toEqual({ source: 'list', kind: 'click', index: 2 })
    expect(
      input('list_event', { Container_ID: 2, CurrentSelect_ItemIndex: '1' }),
    ).toEqual({ source: 'list', kind: 'click', index: 1 })
  })

  it('treats a sys event without eventType as a click', () => {
    expect(input('sysEvent', {})).toEqual({ source: 'sys', kind: 'click' })
  })

  it('reads double-tap, scroll, long press and lifecycle events', () => {
    expect(input('sysEvent', { eventType: 3 })?.kind).toBe('double_click')
    expect(input('textEvent', { containerID: 1, eventType: 1 })).toEqual({
      source: 'text',
      kind: 'scroll_up',
    })
    expect(input('textEvent', { containerID: 1, eventType: 2 })?.kind).toBe(
      'scroll_down',
    )
    expect(input('sysEvent', { eventType: 9, eventSource: 1 })?.kind).toBe(
      'long_press',
    )
    expect(
      input('sysEvent', { eventType: 'LONG_PRESS_RELEASE_EVENT' })?.kind,
    ).toBe('long_press_release')
    expect(input('sysEvent', { eventType: 7 })?.kind).toBe('system_exit')
  })

  it('never turns an unknown event type into a click', () => {
    expect(input('sysEvent', { eventType: 42 })).toEqual({
      source: 'sys',
      kind: 'unknown',
    })
    expect(
      input('listEvent', { Event_Type: 99, currentSelectItemIndex: 1 })?.kind,
    ).toBe('unknown')
  })

  it('ignores audio and menu events', () => {
    expect(input('audioEvent', { audioPcm: [0, 0] })).toBeNull()
    expect(input('menuItemClickEvent', { itemID: 1 })).toBeNull()
  })
})
