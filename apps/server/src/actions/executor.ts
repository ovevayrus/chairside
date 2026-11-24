import { randomUUID } from 'node:crypto'
import type { ActionRequest, ActionResponse } from '@chairside/shared'
import { proposal } from '../requests/cards.js'
import { reserve } from './booking.js'
import {
  finish,
  publish,
  replay,
  type ActionContext,
  type ActionRow,
} from './context.js'
import { sendReply } from './send.js'

export class ActionExecutor {
  constructor(private readonly ctx: ActionContext) {}

  async execute(input: ActionRequest): Promise<ActionResponse> {
    const outcome = await this.ctx.store.withLock(() => this.run(input))
    if (outcome.changed)
      await publish(this.ctx, input.requestId, outcome.response)
    return outcome.response
  }

  private async run(
    input: ActionRequest,
  ): Promise<{ response: ActionResponse; changed: boolean }> {
    const { ctx } = this
    const { store } = ctx
    const row = store.get(input.requestId)
    if (!row)
      return {
        response: { status: 'error', receipt: 'Unknown request' },
        changed: false,
      }
    const action = store.transaction(() => {
      const id = randomUUID()
      const now = store.now().toISOString()
      store.db
        .prepare(
          `INSERT OR IGNORE INTO actions
        (id,request_id,version,action_id,idempotency_key,state,created_at,updated_at)
        VALUES(?,?,?,?,?,'received',?,?)`,
        )
        .run(
          id,
          row.id,
          input.version,
          input.actionId,
          input.idempotencyKey,
          now,
          now,
        )
      // Check the key first: a key reused with a changed payload cannot expose or replay another action.
      const found = (store.db
        .prepare('SELECT * FROM actions WHERE idempotency_key=?')
        .get(input.idempotencyKey) ??
        store.db
          .prepare(
            'SELECT * FROM actions WHERE request_id=? AND version=? AND action_id=?',
          )
          .get(row.id, input.version, input.actionId)) as unknown as ActionRow
      return { current: found, fresh: found.id === id }
    })
    const a = action.current
    if (!action.fresh) {
      const response: ActionResponse =
        a.request_id === row.id &&
        a.version === input.version &&
        a.action_id === input.actionId
          ? replay(a)
          : {
              status: 'error',
              receipt: 'Idempotency key belongs to another action',
            }
      return { response, changed: false }
    }
    const visible = store.pending(row.chat_id).some((r) => r.id === row.id)
    if (row.version !== input.version || !visible) {
      return {
        response: finish(ctx, a, {
          status: 'stale',
          ...(visible && { card: store.card(row) }),
        }),
        changed: false,
      }
    }
    const proposals = store.proposals(row)
    const p =
      proposals.find((p) => p.id === input.actionId) ??
      (input.actionId === 'not_now' && store.replyBlock(row)
        ? proposal('not_now', 'Not now')
        : undefined)
    if (!p)
      return {
        response: finish(ctx, a, {
          status: 'error',
          receipt: 'Unknown action',
        }),
        changed: false,
      }
    if (['not_now','calendar_error','unknown_book','unknown_reply'].includes(p.kind)) {
      return {
        response: store.transaction(() => {
          store.close(row.id, 'dismissed')
          return finish(ctx, a, { status: 'ok', receipt: 'Dismissed' })
        }),
        changed: true,
      }
    }
    if (store.replyBlock(row))
      return {
        response: finish(ctx, a, {
          status: 'window_closed',
          card: store.card(row),
          receipt: 'Cannot reply in Telegram',
        }),
        changed: true,
      }
    if (p.kind === 'book') {
      const response = await reserve(ctx, a, row, p)
      if (response) return { response, changed: true }
    } else if (
      ![
        'offer',
        'ask_day',
        'ask_time',
        'retry_book',
        'retry_offer',
        'retry_offer_accepted',
        'retry_ask_day',
        'retry_ask_time',
      ].includes(p.kind)
    ) {
      return {
        response: finish(ctx, a, {
          status: 'error',
          receipt: 'Unknown action',
        }),
        changed: false,
      }
    }
    return { response: await sendReply(ctx, a, row, p), changed: true }
  }
}
