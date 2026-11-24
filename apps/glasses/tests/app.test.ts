import { evenHubEventFromJson } from '@evenrealities/even_hub_sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChairsideApp,
  MENU,
  PAIR_POLL_MS,
  RECEIPT_MS,
  type AppPlatform,
} from '../src/app'
import { ApiError, type ActionResult } from '../src/net/api'
import type { LiveOptions } from '../src/net/live'
import type { Card, StateFrame } from '../src/net/protocol'
import { KEYS } from '../src/storage'
import type { Page, TextBox } from '../src/ui/layout'

const TOKEN = 'device-token-0123456789abcdef'

const card: Card = {
  requestId: 'req-1',
  version: 1,
  header: 'NEW REQUEST',
  lines: ['Anna · Skin fade', 'Sat 28 Nov · 15:00 · ● free (45 min)'],
  actions: [
    { id: 'book-1', label: 'Book & reply' },
    { id: 'offer-1', label: 'Offer Sat 28 Nov 15:15' },
    { id: 'skip-1', label: 'Not now' },
  ],
  index: 1,
  total: 1,
}

const second: Card = {
  ...card,
  requestId: 'req-2',
  lines: ['Omar · Beard trim', 'Sat 28 Nov · 17:00 · ● free (20 min)'],
  actions: [{ id: 'book-2', label: 'Book & reply' }],
}

function state(seq: number, cards: Card[] = []): StateFrame {
  return {
    type: 'state',
    seq,
    root: {
      shopName: "Karim's Barbers",
      now: '2026-11-24T10:00:00.000Z',
      next: { time: '14:00', name: 'Sami', service: 'Haircut' },
      pendingCount: cards.length,
      mode: 'test',
    },
    cards,
  }
}

const event = (type: string, jsonData: Record<string, unknown>) =>
  evenHubEventFromJson({ type, jsonData })
const listClick = (index: number) =>
  event('listEvent', { containerID: 4, currentSelectItemIndex: index })
const click = () => event('sysEvent', {})
const doubleTap = () => event('sysEvent', { eventType: 3 })
const swipe = () => event('textEvent', { containerID: 4, eventType: 2 })
const menu = (itemID: number) => event('menuItemClickEvent', { itemID })

function setup(stored: Record<string, string> = {}) {
  const pages: Page[] = []
  const logs: string[] = []
  const store = new Map(Object.entries(stored))
  let live: LiveOptions | undefined
  const handle = { start: vi.fn(), stop: vi.fn(), resync: vi.fn() }
  let keys = 0
  const api = {
    liveUrl: 'ws://localhost:8787/ws',
    pairStart: vi.fn(async () => ({
      code: 'K7P2QX',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    })),
    pairStatus: vi.fn(
      async () =>
        ({ status: 'pending' as const }) as {
          status: 'pending' | 'paired' | 'expired'
          deviceToken?: string
        },
    ),
    state: vi.fn(async () => state(1)),
    action: vi.fn<() => Promise<ActionResult>>(),
  }
  const probeTestMode = vi.fn(async () => false)
  const platform: AppPlatform = {
    show: async (page) => {
      pages.push(page)
    },
    invalidate: vi.fn(),
    exit: vi.fn(async () => {}),
    storage: {
      get: async (key) => store.get(key) ?? '',
      set: async (key, value) => {
        store.set(key, value)
        return true
      },
    },
    api,
    createLive: (options) => {
      live = options
      return handle
    },
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: (id) =>
        clearInterval(id as ReturnType<typeof setInterval>),
    },
    now: () => Date.now(),
    randomKey: (bytes) => `${++keys}`.padStart(bytes * 2, 'k'),
    log: (line) => logs.push(line),
    formatDate: () => 'Tue 24 Nov',
    formatTime: () => '14:35',
  }
  const app = new ChairsideApp(platform, {
    appVersion: '0.1.0',
    probeTestMode,
  })
  const page = () => pages.at(-1)!
  const text = (name: string) => {
    const box = page().boxes.find((b) => b.name === name)
    return box?.kind === 'text' ? box.content.trim() : undefined
  }
  return {
    app,
    platform,
    pages,
    logs,
    store,
    api,
    handle,
    page,
    text,
    probeTestMode,
    live: () => live!,
  }
}

const settle = () => vi.advanceTimersByTimeAsync(1)

/** A paired app on root with the live channel up. */
async function paired(cards: Card[] = [], stored: Record<string, string> = {}) {
  const env = setup({ [KEYS.token]: TOKEN, ...stored })
  await env.app.start()
  env.live().onLink('live')
  env.live().onFrame(state(1, cards), 'socket')
  await settle()
  return env
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-24T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pairing', () => {
  it('shows the code on first run, stores the token once paired, then opens root and the live channel', async () => {
    const env = setup()
    env.probeTestMode.mockResolvedValue(true)
    await env.app.start()
    await settle()
    expect(env.logs.slice(0, 2)).toEqual(['ready', 'screen=pair'])
    expect(env.logs).toContain('pair code issued')
    expect(env.text('code')).toBe('/pair K7P2QX')
    expect(env.text('meta')).toBe('TEST')
    expect(env.api.pairStart).toHaveBeenCalledWith(expect.any(String))
    const nonce = env.api.pairStart.mock.calls[0]![0] as string
    expect(nonce.length).toBeGreaterThanOrEqual(16)

    env.api.pairStatus.mockResolvedValueOnce({
      status: 'paired',
      deviceToken: TOKEN,
    })
    await vi.advanceTimersByTimeAsync(PAIR_POLL_MS)
    expect(env.api.pairStatus).toHaveBeenCalledWith(nonce)
    expect(env.store.get(KEYS.token)).toBe(TOKEN)
    expect(env.logs).toContain('paired')
    expect(env.logs).toContain('screen=root')
    expect(env.live().token).toBe(TOKEN)
    expect(env.handle.start).toHaveBeenCalledTimes(1)
    // No log line ever carries the token or the code.
    expect(env.logs.join('\n')).not.toContain(TOKEN)
    expect(env.logs.join('\n')).not.toContain('K7P2QX')
  })

  it('offers a new code after expiry, on tap', async () => {
    const env = setup()
    await env.app.start()
    await settle()
    env.api.pairStatus.mockResolvedValueOnce({ status: 'expired' })
    await vi.advanceTimersByTimeAsync(PAIR_POLL_MS)
    expect(env.text('expiry')).toBe('Code expired · tap for a new code')
    env.app.handleEvent(click())
    await settle()
    expect(env.api.pairStart).toHaveBeenCalledTimes(2)
    expect(env.text('expiry')).toBe('Code expires in 10 min')
  })

  it('pairs again when the server rejects the stored token', async () => {
    const env = await paired()
    env.live().onUnauthorized()
    await settle()
    expect(env.handle.stop).toHaveBeenCalled()
    expect(env.store.get(KEYS.token)).toBe('')
    expect(env.page().screen).toBe('pair')
    expect(env.logs).toContain('device token rejected · pairing again')
  })
})

describe('cards', () => {
  it('opens a new card by itself and books it with one tap: receipt, then root', async () => {
    const env = await paired()
    expect(env.page().screen).toBe('root')
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    expect(env.logs).toContain('card shown req=req-1 v=1')
    expect(env.page().screen).toBe('card')
    expect(env.text('meta')).toBe('TEST')

    env.api.action.mockResolvedValue({
      httpStatus: 200,
      response: { status: 'ok', receipt: '● Booked Sat 28 Nov 15:00' },
    })
    env.app.handleEvent(listClick(0))
    await settle()
    expect(env.api.action).toHaveBeenCalledWith(TOKEN, {
      requestId: 'req-1',
      version: 1,
      actionId: 'book-1',
      idempotencyKey: expect.stringMatching(/^.{16,}$/),
    })
    expect(env.logs).toContain('action sent req=req-1 action=book-1')
    expect(env.logs).toContain('action result req=req-1 status=ok')
    expect(env.page().screen).toBe('receipt')
    expect(env.text('message')).toBe(
      '● Booked Sat 28 Nov 15:00\nAnna · Skin fade',
    )
    // The server's own receipt frame for this action is not shown twice.
    env
      .live()
      .onFrame({ type: 'card.remove', seq: 3, requestId: 'req-1' }, 'socket')
    env.live().onFrame(
      {
        type: 'receipt',
        seq: 4,
        requestId: 'req-1',
        text: '● Booked Sat 28 Nov 15:00',
      },
      'socket',
    )
    await vi.advanceTimersByTimeAsync(RECEIPT_MS)
    expect(env.page().screen).toBe('root')
    expect(env.text('pending')).toBe('○ No requests waiting')
    expect(
      env.pages.filter((p) => p.screen === 'receipt').length,
    ).toBeGreaterThan(0)
    expect(env.logs.filter((line) => line === 'screen=receipt')).toHaveLength(1)
  })

  it('shows the sending state at once and sends a fresh idempotency key for every tap', async () => {
    const env = await paired()
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    env.live().onFrame({ type: 'card.upsert', seq: 3, card: second }, 'socket')
    await settle()
    expect(env.text('meta')).toBe('TEST · 1/2')
    let answer: (result: ActionResult) => void = () => {}
    env.api.action.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    )
    env.app.handleEvent(listClick(0))
    await settle()
    expect(env.text('title')).toBe('SENDING...')
    // A second tap while the first is in flight does nothing.
    env.app.handleEvent(listClick(0))
    await settle()
    expect(env.api.action).toHaveBeenCalledTimes(1)
    answer({ httpStatus: 200, response: { status: 'ok', receipt: '● Booked' } })
    await settle()
    expect(env.text('footer')).toBe('Next request in 2 s · Tap: now')
    await vi.advanceTimersByTimeAsync(RECEIPT_MS)
    expect(env.logs).toContain('card shown req=req-2 v=1')
    env.api.action.mockResolvedValue({
      httpStatus: 200,
      response: { status: 'ok', receipt: '● Booked' },
    })
    env.app.handleEvent(listClick(0))
    await settle()
    const keys = env.api.action.mock.calls.map(
      (call) =>
        (call as unknown as [string, { idempotencyKey: string }])[1]
          .idempotencyKey,
    )
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })

  it('slot_taken: shows the new version with a bright "nothing sent" header', async () => {
    const env = await paired()
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    const taken: Card = {
      ...card,
      version: 2,
      lines: ['Anna · Skin fade', 'Sat 28 Nov · 15:00 · ○ taken'],
      actions: [
        { id: 'offer-2', label: 'Offer Sat 28 Nov 15:45' },
        { id: 'ask-2', label: 'Ask for another time' },
      ],
    }
    env.api.action.mockResolvedValue({
      httpStatus: 200,
      response: {
        status: 'slot_taken',
        card: taken,
        receipt: 'Slot just taken',
      },
    })
    env.app.handleEvent(listClick(0))
    await settle()
    expect(env.logs).toContain('action result req=req-1 status=slot_taken')
    expect(env.logs).toContain('card shown req=req-1 v=2')
    expect(env.page().screen).toBe('card')
    const title = env.page().boxes.find((b) => b.name === 'title') as TextBox
    expect(title.content).toBe('JUST TAKEN · NOTHING SENT')
    expect(title.brightness).toBe(4)
    expect(env.page().boxes.find((b) => b.kind === 'list')).toMatchObject({
      items: ['Offer Sat 28 Nov 15:45', 'Ask for another time'],
    })
  })

  it('a card that changed under the tap (409) comes back with its new version', async () => {
    const env = await paired()
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    env.api.action.mockResolvedValue({
      httpStatus: 409,
      response: { status: 'stale', card: { ...card, version: 3 } },
    })
    env.app.handleEvent(listClick(1))
    await settle()
    expect(env.logs).toContain('card shown req=req-1 v=3')
    expect(env.text('title')).toBe('CHANGED · CHECK AGAIN')
  })

  it('no answer: says nothing is confirmed and returns to the card', async () => {
    const env = await paired()
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    env.api.action.mockRejectedValue(new ApiError('timeout'))
    env.app.handleEvent(listClick(0))
    await settle()
    expect(env.logs).toContain('action result req=req-1 status=unconfirmed')
    expect(env.text('title')).toBe('NOT CONFIRMED')
    await vi.advanceTimersByTimeAsync(RECEIPT_MS)
    expect(env.page().screen).toBe('card')
  })

  it('ignores deltas older than the last state', async () => {
    const env = await paired()
    env.live().onFrame(state(10), 'socket')
    env.live().onFrame({ type: 'card.upsert', seq: 9, card }, 'socket')
    await settle()
    expect(env.page().screen).toBe('root')
    expect(env.logs.some((line) => line.startsWith('card shown'))).toBe(false)
  })

  it('counts cards waiting at start-up on root instead of opening them', async () => {
    const env = await paired([card, second])
    expect(env.page().screen).toBe('root')
    expect(env.text('pending')).toBe('● 2 requests waiting · tap to open')
    env.app.handleEvent(click())
    await settle()
    expect(env.logs).toContain('card shown req=req-1 v=1')
  })
})

describe('gestures', () => {
  it('root double-tap asks the system for the exit dialog', async () => {
    const env = await paired()
    env.app.handleEvent(doubleTap())
    await settle()
    expect(env.platform.exit).toHaveBeenCalledTimes(1)
  })

  it('every root gesture has visible feedback', async () => {
    const env = await paired()
    env.app.handleEvent(click())
    await settle()
    expect(env.text('pending')).toBe('○ Nothing to open right now')
    env.app.handleEvent(swipe())
    await settle()
    expect(env.text('pending')).toBe('▷ Refreshing...')
    expect(env.handle.resync).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(env.text('pending')).toBe('○ No requests waiting')
  })

  it('card double-tap goes back to root and the card does not reopen by itself', async () => {
    const env = await paired()
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    env.app.handleEvent(doubleTap())
    await settle()
    expect(env.page().screen).toBe('root')
    expect(env.platform.exit).not.toHaveBeenCalled()
    env.live().onFrame(state(3, [card]), 'socket')
    await settle()
    expect(env.page().screen).toBe('root')
    expect(env.text('pending')).toBe('● 1 request waiting · tap to open')
    // A new version (the customer edited the message) does open again.
    env
      .live()
      .onFrame(
        { type: 'card.upsert', seq: 4, card: { ...card, version: 2 } },
        'socket',
      )
    await settle()
    expect(env.logs).toContain('card shown req=req-1 v=2')
  })

  it('menu: pause stops cards from opening by themselves until resumed', async () => {
    const env = await paired()
    const at = Date.now()
    env.app.handleEvent(menu(MENU.pause))
    await settle()
    expect(env.store.get(KEYS.pausedUntil)).toBe(String(at + 30 * 60_000))
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await vi.advanceTimersByTimeAsync(2000)
    expect(env.page().screen).toBe('root')
    expect(env.text('pending')).toBe('■ Cards paused until 14:35 · 1 waiting')
    env.app.handleEvent(menu(MENU.pause))
    await settle()
    expect(env.logs).toContain('card shown req=req-1 v=1')
  })

  it('menu: refresh resyncs the live channel', async () => {
    const env = await paired()
    env.app.handleEvent(menu(MENU.refresh))
    await settle()
    expect(env.handle.resync).toHaveBeenCalled()
  })
})

describe('connection', () => {
  it('shows the status screen while offline and returns when the link is back', async () => {
    const env = await paired()
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    env.live().onLink('offline')
    await settle()
    expect(env.logs).toContain('screen=status')
    expect(env.text('message')).toBe(
      'Reconnecting...\nRequests are queued safely',
    )
    expect(env.text('meta')).toBe('TEST · OFFLINE')
    env.app.handleEvent(click())
    await settle()
    expect(env.text('footer')).toBe('Retrying now...')
    env.live().onLink('polling')
    env.live().onFrame(state(1, [card]), 'poll')
    await settle()
    expect(env.page().screen).toBe('card')
  })

  it('a foreground return redraws and resyncs as a cold start', async () => {
    const env = await paired()
    env.app.handleEvent(event('sysEvent', { eventType: 4 }))
    await settle()
    expect(env.platform.invalidate).toHaveBeenCalled()
    expect(env.handle.resync).toHaveBeenCalled()
  })

  it('every header says TEST in TEST MODE, from the first frame', async () => {
    const env = await paired([], { [KEYS.mode]: 'test' })
    env.live().onFrame({ type: 'card.upsert', seq: 2, card }, 'socket')
    await settle()
    env.api.action.mockResolvedValue({
      httpStatus: 200,
      response: { status: 'ok', receipt: '● Booked' },
    })
    env.app.handleEvent(listClick(0))
    await settle()
    env.live().onLink('offline')
    await settle()
    const screens = new Set(env.pages.map((p) => p.screen))
    expect(screens).toEqual(new Set(['root', 'card', 'receipt', 'status']))
    for (const page of env.pages) {
      const meta = page.boxes.find((b) => b.name === 'meta') as TextBox
      expect(meta.content.trim(), page.screen).toMatch(/^TEST\b/)
    }
  })
})
