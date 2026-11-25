import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  customerLines,
  defaultDay,
  entryTime,
  parseArgs,
  renderReport,
  secondsBetween,
  spokenDay,
} from './smoke-report.mjs'

describe('parseArgs', () => {
  it('uses the defaults with no arguments', () => {
    expect(parseArgs([])).toEqual(DEFAULTS)
  })

  it('reads every option', () => {
    expect(
      parseArgs([
        '--day',
        '2026-12-05',
        '--pause',
        '0',
        '--wait',
        '2.5',
        '--no-final-dm',
        '--keep-demo',
      ]),
    ).toEqual({
      day: '2026-12-05',
      pauseS: 0,
      waitMin: 2.5,
      finalDm: false,
      keepDemo: true,
    })
  })

  it('rejects bad values and unknown flags', () => {
    expect(() => parseArgs(['--day', '5 Dec'])).toThrow(/yyyy-MM-dd/)
    expect(() => parseArgs(['--day', '2026-02-30'])).toThrow(/yyyy-MM-dd/)
    expect(() => parseArgs(['--day'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--wait', '0'])).toThrow(/positive/)
    expect(() => parseArgs(['--pause', '-1'])).toThrow(/non-negative/)
    expect(() => parseArgs(['--fast'])).toThrow(/unknown argument/)
  })
})

describe('the booking day', () => {
  it('is the first Saturday at least two days ahead in the shop zone', () => {
    // Tue 24 Nov 2026 22:00 in New York (already Wednesday in UTC).
    const now = Date.parse('2026-11-25T03:00:00Z')
    expect(defaultDay(now, 'America/New_York')).toBe('2026-11-28')
    // Fri 27 Nov: Saturday is only one day ahead, so the next one.
    expect(defaultDay(Date.parse('2026-11-27T15:00:00Z'), 'America/New_York')).toBe(
      '2026-12-05',
    )
  })

  it('is spoken the way the customers write it', () => {
    expect(spokenDay('2026-12-05')).toBe('Saturday 5 Dec')
    expect(customerLines('2026-12-05')).toEqual({
      anna: 'Can I get a skin fade Saturday 5 Dec at 3pm?',
      omar: 'Can I get a skin fade Saturday 5 Dec at 3pm?',
      yes: 'yes',
      beard: 'can you also do a beard trim Saturday 5 Dec at 5pm?',
      final: 'Could I come in for a haircut Saturday 5 Dec at 11am?',
    })
  })
})

describe('times', () => {
  it('rounds seconds to 2 decimals and refuses missing instants', () => {
    expect(secondsBetween(1000, 4567)).toBe(3.57)
    expect(secondsBetween(undefined, 4567)).toBeUndefined()
    expect(secondsBetween(Number.NaN, 4567)).toBeUndefined()
  })

  it("uses a console entry's own timestamp only when it agrees with when it was seen", () => {
    expect(entryTime({ ts: 1_000_000_000_500, seenAt: 1_000_000_000_600 })).toBe(
      1_000_000_000_500,
    )
    expect(entryTime({ ts: 1_000_000_000, seenAt: 1_000_000_000_300 })).toBe(
      1_000_000_000_000,
    )
    expect(entryTime({ ts: 5, seenAt: 1_000_000_000_300 })).toBe(1_000_000_000_300)
    expect(entryTime({ seenAt: 1_000_000_000_300 })).toBe(1_000_000_000_300)
  })
})

describe('renderReport', () => {
  const env = {
    node: 'v24.0.0',
    platform: 'win32',
    telegramMode: 'business',
    shopConfig: '../../config/shop.recording.json',
    timezone: 'America/New_York',
    day: '2026-12-05',
    spokenDay: 'Saturday 5 Dec',
  }

  it('reports a partial failed run without inventing values', () => {
    const text = renderReport({
      startedAt: '2026-11-26T15:00:00.000Z',
      ok: false,
      error: 'timed out waiting for the Moment 1 card',
      env,
      checks: [{ ok: true, label: 'paired from scratch' }],
      shots: [],
      timeline: [{ at: '2026-11-26T15:00:01.000Z', text: 'server listening' }],
      pairing: { readyS: 1.2, launchToCodeS: 1.5, codeToPairedS: 20.1, pairedToLiveS: 0.4 },
    })
    expect(text).toContain('Result: **FAIL: timed out waiting for the Moment 1 card**')
    expect(text).toContain('to interrupted')
    expect(text).toContain('Code shown to paired')
    expect(text).toContain('20.1 s')
    expect(text).toContain('| Tap to the reply sent (Telegram confirmed it) | not reached |')
    expect(text).toContain('- PASS: paired from scratch')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('NaN')
  })

  it('reports a passing run with every number in place', () => {
    const text = renderReport({
      startedAt: '2026-11-26T15:00:00.000Z',
      finishedAt: '2026-11-26T15:09:00.000Z',
      ok: true,
      env,
      checks: [{ ok: true, label: 'Moment 3 sent no message (before 2, after 2)' }],
      shots: [{ path: 'docs/evidence/live-smoke-01-pairing.png', caption: 'pairing' }],
      timeline: [],
      moment1: {
        requestId: 'r1',
        dmMessageIds: [101],
        telegramToCardS: 3.4,
        receivedToCardS: 2.9,
        tapToServerS: 0.05,
        tapToReplyS: 1.21,
        tapToReceiptS: 1.3,
        replyMessageId: 102,
        eventId: 'abc',
        eventLocal: 'Sat 5 Dec 15:00-15:45',
        eventVerified: true,
        status: 'ok',
      },
      moment3: {
        before: { sent: 2, events: 2 },
        after: { sent: 2, events: 2 },
        status: 'slot_taken',
      },
    })
    expect(text).toContain('Result: **PASS**')
    expect(text).toContain('| Tap to the reply sent (Telegram confirmed it) | 1.21 |')
    expect(text).toContain('Reply message id 102')
    expect(text).toContain('| 2 | 2 |')
    expect(text).toContain('`docs/evidence/live-smoke-01-pairing.png`: pairing')
  })
})
