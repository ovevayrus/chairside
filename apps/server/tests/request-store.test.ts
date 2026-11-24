import { expect, it } from 'vitest'
import { openDatabase } from '../src/db/index.js'
import { RequestStore } from '../src/db/requests.js'
import { proposal } from '../src/requests/cards.js'
import { loadShopConfig } from '../src/shop/config.js'

it('keeps message identity across a restart and retires a card interrupted during edit', () => {
  const db = openDatabase(':memory:')
  try {
    const options = {
      db,
      shopId: 'test',
      shop: loadShopConfig(),
      mode: 'test' as const,
      business: false,
    }
    const first = new RequestStore(options)
    const row = first.save({
      chatId: 1,
      connectionId: 'connection-a',
      messageIds: [10, 11],
      firstName: 'Anna',
      lastCustomerMsgAt: first.now().toISOString(),
      parsed: {
        intent: 'book',
        serviceId: 'haircut',
        confidence: 1,
        needs: ['date', 'time'],
      },
      proposals: [proposal('ask_day', 'Ask which day suits')],
    })
    first.beginUpdate(row.id)
    const restored = new RequestStore(options)
    for (const messageId of [10, 11]) {
      expect(restored.forMessage('connection-a', 1, messageId)?.id).toBe(row.id)
      expect(restored.forMessage('connection-b', 1, messageId)).toBeUndefined()
    }
    const card = restored.card(restored.pending()[0]!)
    expect(card).toMatchObject({
      header: 'NEEDS YOU',
      version: 2,
      actions: [{ label: 'Not now' }],
    })
  } finally {
    db.close()
  }
})
