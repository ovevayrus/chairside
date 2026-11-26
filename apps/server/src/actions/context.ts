import {
  ActionResponseSchema,
  type ActionResponse,
  type Card,
} from '@chairside/shared'
import type { CalendarAdapter } from '../calendar/adapter.js'
import { bookingFor, releaseBookingChange } from '../db/bookings.js'
import type { RequestRow, RequestStore } from '../db/requests.js'
import type { LiveHub } from '../live/hub.js'
import {
  displayText,
  planLateChange,
  planMoveProposals,
  planProposals,
  type Proposal,
} from '../requests/cards.js'
import type { TelegramAdapter } from '../telegram/adapter.js'

export interface ActionContext {
  store: RequestStore
  calendar: CalendarAdapter
  telegram: TelegramAdapter
  hub: LiveHub
  callbacksSupported: boolean
  checkpoint?: (stage: 'after_insert' | 'after_send_started') => void
}

export interface ActionRow {
  id: string
  request_id: string
  version: number
  action_id: string
  idempotency_key: string
  planned_event_id: string | null
  telegram_message_id: number | null
  result_json: string | null
  state: string
}

/** An existing action row answers with its stored outcome and runs nothing. */
export function replay(row: ActionRow): ActionResponse {
  if (row.result_json)
    return ActionResponseSchema.parse(JSON.parse(row.result_json))
  return { status: 'error', receipt: 'Action in progress · check status' }
}

/** Pushes an action's outcome to the shop's devices, naming the action by its key. */
export async function publish(
  ctx: ActionContext,
  requestId: string,
  response: ActionResponse,
  idempotencyKey: string,
): Promise<void> {
  const { store, hub } = ctx
  if (response.card)
    hub.broadcast(store.shopId, { type: 'card.upsert', card: response.card })
  else if (!store.pending().some((r) => r.id === requestId))
    hub.broadcast(store.shopId, { type: 'card.remove', requestId })
  if (response.receipt)
    hub.broadcast(store.shopId, {
      type: 'receipt',
      requestId,
      idempotencyKey,
      text: response.receipt,
    })
  await hub.broadcastState(store.shopId)
}

export function finish(
  ctx: ActionContext,
  action: ActionRow,
  response: ActionResponse,
  state: string = response.status,
): ActionResponse {
  ctx.store.db
    .prepare('UPDATE actions SET state=?,result_json=?,updated_at=? WHERE id=?')
    .run(
      state,
      JSON.stringify(response),
      ctx.store.now().toISOString(),
      action.id,
    )
  return response
}

export function replaceCard(
  ctx: ActionContext,
  row: RequestRow,
  status: string,
  proposals: Proposal[],
): Card {
  const { store } = ctx
  return store.transaction(() => {
    store.close(row.id, status)
    const revised = store.get(row.id)!
    store.insertProposals(revised, proposals)
    return store.card(revised)
  })
}

/** A conflict response can arrive before freeBusy reflects the competing event. */
export async function taken(
  ctx: ActionContext,
  action: ActionRow,
  row: RequestRow,
  p: Proposal,
): Promise<ActionResponse> {
  const { store } = ctx
  const startUtc = p.slot_start_utc!
  const endUtc = p.slot_end_utc!
  const booking =
    p.kind === 'late_shift' || p.kind.startsWith('move')
      ? bookingFor(store, row.booking_id)
      : undefined
  const blocked = [{ startUtc, endUtc }]
  const latePlan =
    booking && p.kind === 'late_shift'
      ? await planLateChange(
          booking,
          startUtc,
          store.shop,
          ctx.calendar,
          store.now(),
          blocked,
        )
      : undefined
  const proposals =
    latePlan?.proposals ??
    (booking
      ? await planMoveProposals(
          booking,
          startUtc,
          store.shop,
          ctx.calendar,
          store.now(),
          { blocked },
        )
      : await planProposals(
          {
            intent: 'book',
            serviceId: row.service_id ?? store.shop.defaultServiceId,
            startUtc,
            confidence: 1,
            needs: [],
          },
          store.shop,
          ctx.calendar,
          store.now(),
          blocked,
        ))
  // A customer said yes to a slot that has gone: the card says so and offers the next one.
  const accepted =
    p.kind === 'offer_accepted' || p.kind === 'move_offer_accepted'
  const name = displayText(row.customer_first_name, 24) || 'Customer'
  return store.transaction(() => {
    releaseBookingChange(store, row.booking_id, action.id)
    if (latePlan)
      store.db
        .prepare('UPDATE requests SET late_impact=? WHERE id=?')
        .run(latePlan.lateImpact ?? null, row.id)
    const card = replaceCard(
      ctx,
      row,
      accepted ? 'slot_taken_accepted' : 'pending',
      proposals,
    )
    return finish(ctx, action, {
      status: 'slot_taken',
      card,
      receipt: accepted
        ? `${name} said yes · slot just taken`
        : 'Slot just taken',
    })
  })
}
