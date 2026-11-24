import type { ActionResponse, Card } from '@chairside/shared'
import type { CalendarAdapter } from '../calendar/adapter.js'
import type { RequestRow, RequestStore } from '../db/requests.js'
import type { LiveHub } from '../live/hub.js'
import { planProposals, type Proposal } from '../requests/cards.js'
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
  const proposals = await planProposals(
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
    [{ startUtc, endUtc }],
  )
  return store.transaction(() => {
    const card = replaceCard(ctx, row, 'pending', proposals)
    return finish(ctx, action, {
      status: 'slot_taken',
      card,
      receipt: 'Slot just taken',
    })
  })
}
