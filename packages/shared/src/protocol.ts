/// <reference lib="dom" />
// Zod's declarations use the standard URL type.
import { z } from 'zod'

const requestId = z.string().min(1).max(64)
const actionId = z.string().min(1).max(32)
const version = z.int().nonnegative()
const seq = z.int().nonnegative()
const receipt = z.string().max(80)
const timestamp = z.iso.datetime({ offset: true })

export const CardActionSchema = z.object({
  id: actionId,
  label: z.string().max(40),
})

export const CardSchema = z.object({
  requestId,
  version,
  header: z.string().max(32),
  lines: z.array(z.string().max(40)).max(3),
  actions: z.array(CardActionSchema).min(1).max(4),
  index: z.int().positive(),
  total: z.int().positive(),
})

export const SlotSummarySchema = z.object({
  time: z.iso.time({ precision: -1 }),
  name: z.string().max(24),
  service: z.string().max(24),
})

export const RootStateSchema = z.object({
  shopName: z.string().max(40),
  now: timestamp,
  next: SlotSummarySchema.optional(),
  then: SlotSummarySchema.optional(),
  pendingCount: z.int().nonnegative(),
  mode: z.enum(['live', 'test']),
})

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state'),
    seq,
    root: RootStateSchema,
    cards: z.array(CardSchema),
  }),
  z.object({ type: z.literal('card.upsert'), seq, card: CardSchema }),
  z.object({ type: z.literal('card.remove'), seq, requestId }),
  z.object({
    type: z.literal('receipt'),
    seq,
    text: receipt,
    requestId: requestId.optional(),
  }),
  z.object({
    type: z.literal('error'),
    seq,
    code: z.string(),
    message: z.string().max(120),
  }),
])

// Validate a subsequent frame against the last sequence seen on this stream.
export function serverMessageSchemaAfter(
  previousSeq: number,
): typeof ServerMessageSchema {
  return ServerMessageSchema.refine((frame) => frame.seq > previousSeq, {
    path: ['seq'],
    message: 'Sequence must increase',
  })
}

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    token: z.string().min(16).max(256),
    appVersion: z.string().max(32),
  }),
  z.object({ type: z.literal('ping') }),
])

export const ActionRequestSchema = z.object({
  requestId,
  version,
  actionId,
  idempotencyKey: z.string().min(8).max(128),
})

export const ActionResponseSchema = z.object({
  status: z.enum([
    'ok',
    'slot_taken',
    'window_closed',
    'stale',
    'reply_unknown',
    'send_failed',
    'error',
  ]),
  card: CardSchema.optional(),
  receipt: receipt.optional(),
})

export const PairStartRequestSchema = z.object({
  deviceNonce: z.string().min(16).max(128),
})

export const PairStartResponseSchema = z.object({
  code: z.string().regex(/^[A-Z0-9]{6}$/),
  expiresAt: timestamp,
})

export const PairStatusResponseSchema = z.object({
  status: z.enum(['pending', 'paired', 'expired']),
  deviceToken: z.string().optional(),
})

export type CardAction = z.infer<typeof CardActionSchema>
export type Card = z.infer<typeof CardSchema>
export type SlotSummary = z.infer<typeof SlotSummarySchema>
export type RootState = z.infer<typeof RootStateSchema>
export type ServerMessage = z.infer<typeof ServerMessageSchema>
export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type ActionRequest = z.infer<typeof ActionRequestSchema>
export type ActionResponse = z.infer<typeof ActionResponseSchema>
export type PairStartRequest = z.infer<typeof PairStartRequestSchema>
export type PairStartResponse = z.infer<typeof PairStartResponseSchema>
export type PairStatusResponse = z.infer<typeof PairStatusResponseSchema>
