import { describe, expect, it } from 'vitest'
import { asServerFrame } from '../src/net/protocol'

describe('receipt frames', () => {
  const base = { type: 'receipt', seq: 4, requestId: 'req-1', text: '● Booked' }

  it('accepts a receipt with or without the action key', () => {
    expect(asServerFrame(base)).toEqual(base)
    const named = { ...base, idempotencyKey: 'offer:3f2a9c1e-offer-action' }
    expect(asServerFrame(named)).toEqual(named)
  })

  it('rejects a receipt whose action key is not a string', () => {
    expect(asServerFrame({ ...base, idempotencyKey: 42 })).toBeNull()
    expect(asServerFrame({ ...base, text: undefined })).toBeNull()
  })
})
