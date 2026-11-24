import { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { pino } from 'pino'
import { createApp } from './http/app.js'
import { attachLive } from './http/live.js'

const logger = pino()

const port = Number(process.env.PORT || 8787)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `PORT must be an integer from 1 to 65535, got "${process.env.PORT}"`,
  )
}

const server = serve({ fetch: createApp({ logger }).fetch, port }, (info) => {
  logger.info({ port: info.port }, 'chairside server listening')
})
if (!(server instanceof Server)) throw new Error('Expected an HTTP/1.1 server')

attachLive(server, {
  logger,
  acceptDevTokens: process.env.NODE_ENV !== 'production',
})
