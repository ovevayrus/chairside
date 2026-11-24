import type { Server } from 'node:http'
import { ClientMessageSchema, ServerMessageSchema } from '@chairside/shared'
import type { Logger } from 'pino'
import { WebSocketServer, type RawData } from 'ws'
import { createDevAuthenticator, type Authenticate } from '../live/auth.js'
import type { LiveHub } from '../live/hub.js'

export const LIVE_PATH = '/ws'
export const CLOSE_UNAUTHORIZED = 4401

export interface LiveOptions {
  logger: Logger
  /**
   * Accept any well-formed hello token (16+ chars). Dev only: the caller passes
   * `NODE_ENV !== 'production'`; device-token auth replaces this with pairing.
   */
  acceptDevTokens?: boolean
  authenticate?: Authenticate
  hub?: LiveHub
  helloTimeoutMs?: number
}

function readHello(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) return
  try {
    const frame = ClientMessageSchema.safeParse(JSON.parse(data.toString()))
    if (frame.success && frame.data.type === 'hello') return frame.data.token
  } catch {
    return
  }
}

/** Live channel on the HTTP server: the first frame must be a hello within the timeout. */
export function attachLive(
  server: Server,
  options: LiveOptions,
): WebSocketServer {
  const { logger, hub, helloTimeoutMs = 5_000 } = options
  const authenticate =
    options.authenticate ??
    createDevAuthenticator('demo', options.acceptDevTokens === true)
  const wss = new WebSocketServer({
    server,
    path: LIVE_PATH,
    maxPayload: 16 * 1024,
  })

  if (hub) {
    const refresh = setInterval(() => {
      void hub
        .refreshConnected()
        .catch(() => logger.warn('live refresh failed'))
    }, 60_000)
    refresh.unref()
    wss.once('close', () => clearInterval(refresh))
  }

  wss.on('connection', (socket) => {
    const reject = (reason: string) => {
      logger.warn({ reason }, 'live hello rejected')
      socket.close(CLOSE_UNAUTHORIZED, 'unauthorized')
    }
    const timer = setTimeout(() => reject('timeout'), helloTimeoutMs)

    socket.once('message', (data, isBinary) => {
      clearTimeout(timer)
      const token = readHello(data, isBinary)
      if (!token) return reject('invalid')
      const shopId = authenticate(token)
      if (!shopId) return reject('auth_unavailable')
      socket.send(
        JSON.stringify(ServerMessageSchema.parse({ type: 'hello.ok' })),
      )
      if (hub) {
        void hub
          .connect(shopId, socket)
          .catch(() => socket.close(1011, 'state unavailable'))
      }
      logger.info('live hello ok')
    })
    socket.on('close', () => clearTimeout(timer))
    socket.on('error', (error) =>
      logger.warn({ err: error.name }, 'live socket error'),
    )
  })

  return wss
}
