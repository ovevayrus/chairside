// Runtime checks for what the server sends. Types come from @chairside/shared
// (type-only imports, erased at build time, so the bundle carries no zod).
import type {
  ActionResponse,
  Card,
  PairStartResponse,
  PairStatusResponse,
  RootState,
  ServerMessage,
} from '@chairside/shared'

export type ServerFrame = Exclude<ServerMessage, { type: 'hello.ok' }>
export type StateFrame = Extract<ServerMessage, { type: 'state' }>
export type { ActionResponse, Card, RootState }

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

function isSlot(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      isString(value.time) &&
      isString(value.name) &&
      isString(value.service))
  )
}

export function isRootState(value: unknown): value is RootState {
  return (
    isRecord(value) &&
    isString(value.shopName) &&
    isString(value.now) &&
    isCount(value.pendingCount) &&
    (value.mode === 'live' || value.mode === 'test') &&
    isSlot(value.next) &&
    isSlot(value.then)
  )
}

export function isCard(value: unknown): value is Card {
  return (
    isRecord(value) &&
    isString(value.requestId) &&
    isCount(value.version) &&
    isString(value.header) &&
    Array.isArray(value.lines) &&
    value.lines.length <= 3 &&
    value.lines.every(isString) &&
    Array.isArray(value.actions) &&
    value.actions.length >= 1 &&
    value.actions.length <= 4 &&
    value.actions.every(
      (action) =>
        isRecord(action) && isString(action.id) && isString(action.label),
    )
  )
}

/** A sequenced server frame, or null for anything malformed or unknown. */
export function asServerFrame(value: unknown): ServerFrame | null {
  if (!isRecord(value) || !isCount(value.seq)) return null
  switch (value.type) {
    case 'state':
      return isRootState(value.root) &&
        Array.isArray(value.cards) &&
        value.cards.every(isCard)
        ? (value as StateFrame)
        : null
    case 'card.upsert':
      return isCard(value.card) ? (value as ServerFrame) : null
    case 'card.remove':
      return isString(value.requestId) ? (value as ServerFrame) : null
    case 'receipt':
      return isString(value.text) &&
        (value.requestId === undefined || isString(value.requestId)) &&
        (value.idempotencyKey === undefined || isString(value.idempotencyKey))
        ? (value as ServerFrame)
        : null
    case 'error':
      return isString(value.code) && isString(value.message)
        ? (value as ServerFrame)
        : null
    default:
      return null
  }
}

const STATUSES = new Set<ActionResponse['status']>([
  'ok',
  'slot_taken',
  'window_closed',
  'stale',
  'reply_unknown',
  'send_failed',
  'error',
])

export function asActionResponse(value: unknown): ActionResponse | null {
  if (
    !isRecord(value) ||
    !STATUSES.has(value.status as ActionResponse['status'])
  )
    return null
  if (value.card !== undefined && !isCard(value.card)) return null
  if (value.receipt !== undefined && !isString(value.receipt)) return null
  return value as ActionResponse
}

export function asPairStart(value: unknown): PairStartResponse | null {
  return isRecord(value) &&
    isString(value.code) &&
    /^[A-Z0-9]{6}$/.test(value.code) &&
    isString(value.expiresAt) &&
    Number.isFinite(Date.parse(value.expiresAt))
    ? (value as PairStartResponse)
    : null
}

export function asPairStatus(value: unknown): PairStatusResponse | null {
  return isRecord(value) &&
    (value.status === 'pending' ||
      value.status === 'paired' ||
      value.status === 'expired') &&
    (value.deviceToken === undefined || isString(value.deviceToken))
    ? (value as PairStatusResponse)
    : null
}
