import type { Hono } from 'hono'
import { z } from 'zod'
import type { PairingService } from '../devices/pairing.js'

const NonceSchema = z.string().min(16).max(128)
const StartSchema = z.object({ deviceNonce: NonceSchema })

/** Unauthenticated by design: the device has no token yet. Responses are never cached. */
export function mountPairingRoutes(app: Hono, pairing: PairingService): void {
  app.post('/api/pair/start', async (c) => {
    const body = StartSchema.safeParse(await c.req.json().catch(() => null))
    c.header('Cache-Control', 'no-store')
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(pairing.start(body.data.deviceNonce))
  })

  app.get('/api/pair/status', (c) => {
    const nonce = NonceSchema.safeParse(c.req.query('nonce'))
    c.header('Cache-Control', 'no-store')
    if (!nonce.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(pairing.status(nonce.data))
  })
}
