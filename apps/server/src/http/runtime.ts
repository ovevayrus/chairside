import type { CalendarAdapter } from '../calendar/adapter.js'
import type { ActionRequest } from '@chairside/shared'
import type { ActionContext } from '../actions/context.js'
import { ActionExecutor } from '../actions/executor.js'
import { reconcile } from '../actions/reconcile.js'
import { RequestStore, type StoreOptions } from '../db/requests.js'
import { LiveHub } from '../live/hub.js'
import { createRequestPipeline } from '../requests/pipeline.js'
import type { TelegramAdapter } from '../telegram/adapter.js'
import type { ConnectionEvent } from '../telegram/events.js'

export interface RuntimeOptions extends StoreOptions {
  calendar: CalendarAdapter
  telegram: TelegramAdapter
  ownerUserId?: number
  debounceMs?: number
  callbacksSupported?: boolean
  checkpoint?: ActionContext['checkpoint']
  getConnection?: (
    id: string,
  ) => Promise<Omit<ConnectionEvent, 'type' | 'updateId'>>
}

export function createRuntime(options: RuntimeOptions) {
  const store = new RequestStore(options)
  const hub = new LiveHub((shopId) => {
    if (shopId !== store.shopId) throw new Error('Unknown shop')
    return {
      name: store.shop.name,
      timezone: store.shop.timezone,
      mode: store.mode,
      calendar: options.calendar,
      pendingCards: () => {
        const pending = store.pending()
        return pending.map((row) => store.card(row, pending))
      },
    }
  }, store.now)
  const ctx: ActionContext = {
    ...options,
    store,
    hub,
    callbacksSupported: options.callbacksSupported ?? false,
  }
  const executor = new ActionExecutor(ctx)
  const ready = reconcile(ctx)
  const pipeline = createRequestPipeline({ ...options, store, hub })
  const execute = async (input: ActionRequest) => {
    await ready
    return executor.execute(input)
  }
  return { store, hub, pipeline, ready, execute }
}
