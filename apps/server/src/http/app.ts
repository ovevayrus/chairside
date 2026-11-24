import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { Logger } from 'pino'

export interface AppOptions {
  logger: Logger
}

export function createApp({ logger }: AppOptions): Hono {
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

  // Log the failure class and route only: never request bodies or messages.
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    logger.error({ err: error.name, path: c.req.path }, 'request failed')
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
