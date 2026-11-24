import { Hono } from 'hono'
import {
  ActionRequestSchema,
  ActionResponseSchema,
  type ActionRequest,
  type ActionResponse,
} from '@chairside/shared'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { Logger } from 'pino'
import { authenticateBearer, type Authenticate } from '../live/auth.js'
import type { PairingService } from '../devices/pairing.js'
import type { LiveHub } from '../live/hub.js'
import { mountPairingRoutes } from './pairing.js'

export interface AppOptions {
  logger: Logger
  hub?: LiveHub
  authenticate?: Authenticate
  pairing?: PairingService
  execute?: (shopId: string, input: ActionRequest) => Promise<ActionResponse>
}

export function createApp({
  logger,
  hub,
  authenticate,
  pairing,
  execute,
}: AppOptions): Hono {
  const app = new Hono()

  // The glasses WebView calls from its own origin with a bearer token, never
  // cookies, so a wildcard origin is safe. Preflight answers 204.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  )

  app.get('/healthz', (c) => c.json({ ok: true }))

  if (pairing) mountPairingRoutes(app, pairing)

  app.post('/api/actions', async (c) => {
    const shopId =
      authenticate &&
      authenticateBearer(c.req.header('Authorization'), authenticate)
    if (!shopId)
      return c.json(
        ActionResponseSchema.parse({
          status: 'error',
          receipt: 'Unauthorized',
        }),
        401,
      )
    const input = ActionRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!input.success || input.data.idempotencyKey.startsWith('offer:'))
      return c.json(
        ActionResponseSchema.parse({
          status: 'error',
          receipt: 'Invalid action request',
        }),
        400,
      )
    if (!execute)
      return c.json(
        ActionResponseSchema.parse({
          status: 'error',
          receipt: 'Service unavailable',
        }),
        503,
      )
    const response = ActionResponseSchema.parse(
      await execute(shopId, input.data),
    )
    return c.json(response, response.status === 'stale' ? 409 : 200)
  })

  if (hub && authenticate) {
    // A complete snapshot also catches clients up after a server restart.
    app.get('/api/state', async (c) => {
      const shopId = authenticateBearer(
        c.req.header('Authorization'),
        authenticate,
      )
      if (!shopId) return c.json({ error: 'unauthorized' }, 401)
      c.header('Cache-Control', 'no-store')
      return c.json(await hub.snapshot(shopId))
    })
  }

  // Log the failure class and route only: never request bodies or messages.
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    logger.error({ err: error.name, path: c.req.path }, 'request failed')
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
