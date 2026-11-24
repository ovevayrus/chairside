import { describe, expect, it } from 'vitest'
import {
  ActionRequestSchema,
  ActionResponseSchema,
  CardSchema,
  ClientMessageSchema,
  PairStartRequestSchema,
  PairStartResponseSchema,
  PairStatusResponseSchema,
  RootStateSchema,
  ServerMessageSchema,
  serverMessageSchemaAfter,
  type Card,
  type RootState,
} from '../src/index.js'

const action = { id: 'approve', label: 'Approve' }
const card: Card = {
  requestId: 'request-1',
  version: 0,
  header: 'New request',
  lines: ['09:30 haircut'],
  actions: [action],
  index: 1,
  total: 1,
}
const now = '2026-11-24T14:30:00Z'
const root: RootState = {
  shopName: 'Chairside',
  now,
  pendingCount: 1,
  mode: 'test',
}

describe('CardSchema', () => {
  it('accepts a card at the display limits', () => {
    const fullCard = {
      ...card,
      header: 'h'.repeat(32),
      lines: Array(3).fill('l'.repeat(40)),
      actions: Array.from({ length: 4 }, (_, i) => ({
        id: String(i),
        label: 'a'.repeat(40),
      })),
    }
    expect(CardSchema.parse(fullCard)).toEqual(fullCard)
  })

  it.each([
    ['header over 32 characters', { header: 'h'.repeat(33) }],
    ['line over 40 characters', { lines: ['l'.repeat(41)] }],
    ['more than three lines', { lines: ['1', '2', '3', '4'] }],
    [
      'action label over 40 characters',
      { actions: [{ ...action, label: 'a'.repeat(41) }] },
    ],
    [
      'more than four actions',
      {
        actions: Array.from({ length: 5 }, (_, i) => ({
          ...action,
          id: String(i),
        })),
      },
    ],
    ['empty action list', { actions: [] }],
  ] as const)('rejects %s', (_, fields) => {
    expect(CardSchema.safeParse({ ...card, ...fields }).success).toBe(false)
  })
})

it('validates optional root slots, clock times and ISO timestamps', () => {
  const slot = { time: '09:30', name: 'Sam', service: 'Cut' }
  expect(RootStateSchema.parse(root)).toEqual(root)
  const scheduled = { ...root, next: slot, then: { ...slot, time: '23:59' } }
  expect(RootStateSchema.parse(scheduled)).toEqual(scheduled)
  for (const time of ['9:30', '24:00', '09:60']) {
    expect(
      RootStateSchema.safeParse({ ...root, next: { ...slot, time } }).success,
    ).toBe(false)
  }
  expect(RootStateSchema.safeParse({ ...root, now: 'today' }).success).toBe(
    false,
  )
})

describe('live channel', () => {
  it('recognizes hello.ok only before sequenced frames', () => {
    const hello = { type: 'hello.ok' }
    expect(ServerMessageSchema.parse(hello)).toEqual(hello)
    expect(serverMessageSchemaAfter(1).safeParse(hello).success).toBe(false)
  })

  it.each([
    { type: 'state', root, cards: [card] },
    { type: 'card.upsert', card },
    { type: 'card.remove', requestId: card.requestId },
    { type: 'receipt', text: 'Confirmed', requestId: card.requestId },
    { type: 'error', code: 'stale', message: 'Card updated' },
  ])('requires a nonnegative integer sequence on $type', (frame) => {
    expect(ServerMessageSchema.parse({ ...frame, seq: 0 })).toEqual({
      ...frame,
      seq: 0,
    })
    for (const seq of [undefined, -1, 0.5]) {
      expect(ServerMessageSchema.safeParse({ ...frame, seq }).success).toBe(
        false,
      )
    }
  })

  it('rejects repeated and decreasing sequences across frame types', () => {
    const first = ServerMessageSchema.parse({
      type: 'state',
      root,
      cards: [card],
      seq: 4,
    })
    if (first.type !== 'state') throw new Error('expected a state frame')
    const nextFrame = serverMessageSchemaAfter(first.seq)
    const upsert = { type: 'card.upsert', card }
    for (const seq of [3, 4]) {
      expect(nextFrame.safeParse({ ...upsert, seq }).success).toBe(false)
    }
    expect(nextFrame.parse({ ...upsert, seq: 6 }).seq).toBe(6)
  })

  it('recognizes hello and ping as glasses frames', () => {
    const hello = { type: 'hello', token: 't'.repeat(16), appVersion: '1.0' }
    expect(ClientMessageSchema.parse(hello)).toEqual(hello)
    expect(ClientMessageSchema.parse({ type: 'ping' })).toEqual({
      type: 'ping',
    })
    expect(
      ClientMessageSchema.safeParse({ ...hello, token: 'short' }).success,
    ).toBe(false)
    expect(ServerMessageSchema.safeParse({ ...hello, seq: 0 }).success).toBe(
      false,
    )
  })
})

it('validates action requests and responses', () => {
  const request = {
    requestId: card.requestId,
    version: card.version,
    actionId: action.id,
    idempotencyKey: 'k'.repeat(8),
  }
  expect(ActionRequestSchema.parse(request)).toEqual(request)
  expect(
    ActionRequestSchema.safeParse({ ...request, idempotencyKey: 'short' })
      .success,
  ).toBe(false)
  const response = { status: 'slot_taken', card, receipt: 'Select a new slot' }
  expect(ActionResponseSchema.parse(response)).toEqual(response)
  expect(ActionResponseSchema.safeParse({ status: 'unknown' }).success).toBe(
    false,
  )
  expect(
    ActionResponseSchema.safeParse({ status: 'ok', receipt: 'r'.repeat(81) })
      .success,
  ).toBe(false)
})

it('validates pairing requests, codes, expiry and device status', () => {
  const start = { deviceNonce: 'n'.repeat(16) }
  expect(PairStartRequestSchema.parse(start)).toEqual(start)
  expect(
    PairStartRequestSchema.safeParse({ deviceNonce: 'short' }).success,
  ).toBe(false)
  const response = { code: 'A1'.repeat(3), expiresAt: now }
  expect(PairStartResponseSchema.parse(response)).toEqual(response)
  expect(
    PairStartResponseSchema.safeParse({
      ...response,
      code: response.code.toLowerCase(),
    }).success,
  ).toBe(false)
  expect(
    PairStartResponseSchema.safeParse({ ...response, expiresAt: 'later' })
      .success,
  ).toBe(false)
  const paired = { status: 'paired', deviceToken: 't'.repeat(16) }
  expect(PairStatusResponseSchema.parse(paired)).toEqual(paired)
  expect(PairStatusResponseSchema.safeParse({ status: 'ok' }).success).toBe(
    false,
  )
})
