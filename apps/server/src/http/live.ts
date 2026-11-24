import type { Server } from 'node:http'
import { ClientMessageSchema } from '@chairside/shared'
import type { Logger } from 'pino'
import { WebSocketServer, type RawData } from 'ws'

export const LIVE_PATH = '/ws'
export const CLOSE_UNAUTHORIZED = 4401

export interface LiveOptions {
  logger: Logger
  /**
   * Accept any well-formed hello token (16+ chars). Dev only: the caller passes
   * `NODE_ENV !== 'production'`; device-token auth replaces this with pairing.
   */
  acceptDevTokens: boolean
  helloTimeoutMs?: number
}

function readHello(data: RawData, isBinary: boolean): boolean {
  if (isBinary) return false
  try {
    const frame = ClientMessageSchema.safeParse(JSON.parse(data.toString()))
    return frame.success && frame.data.type === 'hello'
  } catch {
    return false
  }
}

/** Live channel on the HTTP server: the first frame must be a hello within the timeout. */
export function attachLive(
  server: Server,
  options: LiveOptions,
): WebSocketServer {
  const { logger, acceptDevTokens, helloTimeoutMs = 5_000 } = options
  const wss = new WebSocketServer({
    server,
    path: LIVE_PATH,
    maxPayload: 16 * 1024,
  })

  wss.on('connection', (socket) => {
    const reject = (reason: string) => {
      logger.warn({ reason }, 'live hello rejected')
      socket.close(CLOSE_UNAUTHORIZED, 'unauthorized')
    }
    const timer = setTimeout(() => reject('timeout'), helloTimeoutMs)

    socket.once('message', (data, isBinary) => {
      clearTimeout(timer)
      if (!readHello(data, isBinary)) return reject('invalid')
      if (!acceptDevTokens) return reject('auth_unavailable')
      // Later frames (state sync, actions) arrive with the protocol stories.
      socket.send(JSON.stringify({ type: 'hello.ok' }))
      logger.info('live hello ok')
    })
    socket.on('close', () => clearTimeout(timer))
    socket.on('error', (error) =>
      logger.warn({ err: error.name }, 'live socket error'),
    )
  })

  return wss
}
