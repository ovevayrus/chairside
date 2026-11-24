import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import type { Card, RootState } from '../src/net/protocol'
import { CARD_HINT, cardScreen } from '../src/screens/card'
import { pairScreen } from '../src/screens/pair'
import { receiptScreen } from '../src/screens/receipt'
import { rootScreen } from '../src/screens/root'
import { statusScreen } from '../src/screens/status'
import {
  isDisplayable,
  layoutKey,
  pageProblems,
  type Page,
  type TextBox,
} from '../src/ui/layout'
import { containers, menuObject } from '../src/ui/render'

const card: Card = {
  requestId: 'req-1',
  version: 1,
  header: 'NEW REQUEST',
  lines: ['Anna · Skin fade', 'Sat 28 Nov · 15:00 · ● free (45 min)'],
  actions: [
    { id: 'a1', label: 'Book & reply' },
    { id: 'a2', label: 'Offer Sat 28 Nov 15:15' },
    { id: 'a3', label: 'Not now' },
  ],
  index: 1,
  total: 1,
}

const root: RootState = {
  shopName: "Karim's Barbers",
  now: '2026-11-24T10:00:00.000Z',
  next: { time: '14:00', name: 'Sami', service: 'Haircut' },
  then: { time: '16:15', name: 'Busy', service: '' },
  pendingCount: 2,
  mode: 'test',
}

/** The worst a server card can be: 32-char header, 3 x 40-char lines, 4 x 40-char labels. */
const widest: Card = {
  ...card,
  header: 'W'.repeat(32),
  lines: ['W'.repeat(40), 'M'.repeat(40), '●'.repeat(40)],
  actions: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, label: 'W'.repeat(40) })),
}

function text(page: Page, name: string): string {
  const box = page.boxes.find((b) => b.name === name)
  if (!box || box.kind !== 'text') throw new Error(`no text box ${name}`)
  return box.content
}

/** The header's right-hand text without its alignment padding. */
const meta = (page: Page) => text(page, 'meta').trim()

const MENU = [
  { id: 1, label: 'Refresh' },
  { id: 2, label: 'Pause cards 30 min' },
]

/** Every page must pass our checks and the SDK's own validator. */
function expectValid(page: Page) {
  expect(pageProblems(page)).toEqual([])
  expect(
    validateEvenHubPageContainer({
      ...containers(page),
      menuObject: menuObject(MENU),
    }),
  ).toEqual({ valid: true })
  for (const box of page.boxes) {
    const content = box.kind === 'text' ? [box.content] : box.items
    for (const value of content) expect(isDisplayable(value)).toBe(true)
  }
}

describe('pair screen', () => {
  it('shows the steps and the code, centered in its own box', () => {
    const page = pairScreen({ test: true, code: 'K7P2QX', minutesLeft: 10 })
    expectValid(page)
    expect(text(page, 'title')).toBe('PAIR CHAIRSIDE')
    expect(meta(page)).toBe('TEST')
    expect(text(page, 'steps')).toBe(
      '1. Open Telegram ▶ your Chairside bot\n2. Send:',
    )
    expect(text(page, 'code').trim()).toBe('/pair K7P2QX')
    expect(text(page, 'code').startsWith(' ')).toBe(true)
    expect(text(page, 'expiry')).toBe('Code expires in 10 min')
    const code = page.boxes.find((b) => b.name === 'code') as TextBox
    expect(code.capture).toBe(true)
    expect(code.x * 2 + code.width).toBe(576)
  })

  it('names the bot when the build knows it, and covers every state', () => {
    expect(
      text(pairScreen({ test: false, bot: 'KarimDeskBot' }), 'steps'),
    ).toContain('@KarimDeskBot')
    expect(meta(pairScreen({ test: false }))).toBe('')
    expect(text(pairScreen({ test: false }), 'code').trim()).toBe(
      'Getting a code...',
    )
    const expired = pairScreen({ test: false, code: 'K7P2QX', expired: true })
    expect(text(expired, 'expiry')).toBe('Code expired · tap for a new code')
    expect(text(expired, 'footer')).toContain('Tap: new code')
    expect(
      text(
        pairScreen({ test: false, code: 'K7P2QX', minutesLeft: 0 }),
        'expiry',
      ),
    ).toBe('Code expires in under a minute')
    expect(text(pairScreen({ test: false, offline: true }), 'expiry')).toBe(
      "Can't reach the Chairside server · retrying",
    )
    for (const view of [
      { test: false },
      { test: true, code: 'WWWWWW', minutesLeft: 9 },
      { test: true, code: 'K7P2QX', expired: true },
      {
        test: true,
        offline: true,
        flash: 'Waiting for /pair K7P2QX in Telegram',
      },
    ])
      expectValid(pairScreen(view))
  })

  it('keeps one layout from "getting a code" to the code, so it updates without a rebuild', () => {
    expect(layoutKey(pairScreen({ test: true }))).toBe(
      layoutKey(pairScreen({ test: true, code: 'K7P2QX', minutesLeft: 10 })),
    )
  })
})

describe('root screen', () => {
  it('shows Next and Then, the pending count and the gestures', () => {
    const page = rootScreen({
      root,
      pending: 2,
      test: true,
      date: 'Tue 24 Nov',
    })
    expectValid(page)
    expect(text(page, 'title')).toBe("KARIM'S BARBERS")
    expect(meta(page)).toBe('TEST · Tue 24 Nov')
    expect(text(page, 'labels')).toBe('Next\nThen')
    expect(text(page, 'agenda')).toBe('14:00  Sami · Haircut\n16:15  Busy')
    expect(text(page, 'pending')).toBe('● 2 requests waiting · tap to open')
    expect(text(page, 'footer')).toBe(
      'Tap: open · Swipe: refresh · Double-tap: exit',
    )
    const agenda = page.boxes.find((b) => b.name === 'agenda') as TextBox
    expect(agenda.capture).toBe(true)
  })

  it('covers connecting, an empty day, a calendar error, pause and feedback in one layout', () => {
    const views = [
      { root: undefined, pending: 0 },
      { root: { ...root, next: undefined, then: undefined }, pending: 0 },
      { root: { ...root, next: undefined }, pending: 1, calendarError: true },
      { root, pending: 1, pausedUntil: '14:35' },
      { root, pending: 0, flash: '○ Nothing to open right now' },
      {
        root: {
          ...root,
          next: {
            time: '23:45',
            name: 'W'.repeat(24),
            service: 'M'.repeat(24),
          },
        },
        pending: 99,
      },
    ]
    const pages = views.map((view) =>
      rootScreen({ test: false, date: 'Tue 24 Nov', ...view }),
    )
    for (const page of pages) expectValid(page)
    expect(text(pages[0]!, 'agenda')).toContain('Connecting')
    // Labels are never cut ("Today", not "Tod...").
    expect(text(pages[1]!, 'labels')).toBe('Today\n ')
    expect(text(pages[2]!, 'labels')).toBe('Next\n ')
    expect(text(pages[1]!, 'agenda')).toContain('No more appointments')
    expect(text(pages[2]!, 'agenda')).toContain('Calendar unavailable')
    expect(text(pages[3]!, 'pending')).toBe(
      '■ Cards paused until 14:35 · 1 waiting',
    )
    expect(text(pages[4]!, 'pending')).toBe('○ Nothing to open right now')
    expect(text(pages[5]!, 'agenda')).toMatch(/\.\.\.$/m)
    expect(new Set(pages.map(layoutKey)).size).toBe(1)
    expect(
      text(rootScreen({ root, pending: 1, test: false, date: 'x' }), 'pending'),
    ).toBe('● 1 request waiting · tap to open')
    expect(
      text(rootScreen({ root, pending: 0, test: false, date: 'x' }), 'pending'),
    ).toBe('○ No requests waiting')
  })
})

describe('card screen', () => {
  it('shows header, lines and the actions with the smart default first', () => {
    const page = cardScreen({ card, position: 1, total: 2, test: true })
    expectValid(page)
    expect(text(page, 'title')).toBe('NEW REQUEST')
    expect(meta(page)).toBe('TEST · 1/2')
    expect(text(page, 'body')).toBe(
      'Anna · Skin fade\nSat 28 Nov · 15:00 · ● free (45 min)',
    )
    const list = page.boxes.find((b) => b.kind === 'list')
    expect(list).toMatchObject({
      kind: 'list',
      capture: true,
      items: ['Book & reply', 'Offer Sat 28 Nov 15:15', 'Not now'],
    })
    expect(text(page, 'footer')).toBe(CARD_HINT.replace(/ {2}/g, ' '))
  })

  it('fits the widest card the protocol allows on the 576x288 screen', () => {
    const page = cardScreen({
      card: widest,
      position: 12,
      total: 12,
      test: true,
    })
    expectValid(page)
    expect(text(page, 'body').split('\n')).toHaveLength(3)
    expect(page.boxes.some((b) => b.name === 'footer')).toBe(false)
  })

  it('shows progress in the dim header and an outcome in a bright one', () => {
    const sending = cardScreen({
      card,
      position: 1,
      total: 1,
      test: false,
      note: { text: 'Sending...', alert: false },
    })
    expectValid(sending)
    expect(text(sending, 'title')).toBe('SENDING...')
    expect(meta(sending)).toBe('')
    // Progress keeps the layout, so the header updates in place.
    expect(layoutKey(sending)).toBe(
      layoutKey(cardScreen({ card, position: 1, total: 1, test: false })),
    )
    const taken = cardScreen({
      card,
      position: 1,
      total: 1,
      test: true,
      note: { text: 'Just taken · nothing sent', alert: true },
    })
    expectValid(taken)
    const title = taken.boxes.find((b) => b.name === 'title') as TextBox
    expect(title.content).toBe('JUST TAKEN · NOTHING SENT')
    expect(title.brightness).toBe(4)
  })

  it('drops glyphs the glasses cannot draw from server text', () => {
    const page = cardScreen({
      card: {
        ...card,
        lines: ['Zoë 💈 · Skin fade', 'Sat 28 Nov → 15:00'],
        actions: [{ id: 'a', label: 'Book ✓' }],
      },
      position: 1,
      total: 1,
      test: false,
    })
    expectValid(page)
    expect(text(page, 'body')).toBe('Zoe · Skin fade\nSat 28 Nov -> 15:00')
    expect(page.boxes.find((b) => b.kind === 'list')).toMatchObject({
      items: ['Book'],
    })
  })
})

describe('receipt and status screens', () => {
  it('shows what happened and where the app goes next', () => {
    const page = receiptScreen({
      title: 'Done',
      text: '● Booked Sat 28 Nov 15:00',
      detail: 'Anna · Skin fade',
      hint: 'Next request in 2 s  ·  Tap: now',
      test: true,
    })
    expectValid(page)
    expect(text(page, 'title')).toBe('DONE')
    expect(meta(page)).toBe('TEST')
    expect(text(page, 'message')).toBe(
      '● Booked Sat 28 Nov 15:00\nAnna · Skin fade',
    )
    expect(text(page, 'footer')).toBe('Next request in 2 s · Tap: now')
  })

  it('says the link is down and that requests are safe', () => {
    const page = statusScreen({ test: true })
    expectValid(page)
    expect(text(page, 'title')).toBe('CHAIRSIDE')
    expect(meta(page)).toBe('TEST · OFFLINE')
    expect(text(page, 'message')).toBe(
      'Reconnecting...\nRequests are queued safely',
    )
    expect(text(page, 'footer')).toBe('Tap: retry now · Double-tap: exit')
    // Receipt and status share a layout: switching between them never flickers.
    expect(layoutKey(page)).toBe(
      layoutKey(
        receiptScreen({ title: 'x', text: 'y', hint: 'z', test: true }),
      ),
    )
  })
})

describe('TEST MODE', () => {
  it('puts TEST in every screen header, and nowhere in live mode', () => {
    const screens = (test: boolean) => [
      pairScreen({ test, code: 'K7P2QX', minutesLeft: 5 }),
      rootScreen({
        root: { ...root, mode: test ? 'test' : 'live' },
        pending: 1,
        test,
        date: 'Tue 24 Nov',
      }),
      cardScreen({ card, position: 1, total: 1, test }),
      receiptScreen({ title: 'Done', text: 'x', hint: 'y', test }),
      statusScreen({ test }),
    ]
    for (const page of screens(true))
      expect(meta(page), page.screen).toMatch(/^TEST\b/)
    for (const page of screens(false))
      expect(meta(page), page.screen).not.toMatch(/TEST/)
  })
})
