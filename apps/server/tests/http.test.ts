import { once } from 'node:events'
import { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createApp } from '../src/http/app.js'
import { attachLive, CLOSE_UNAUTHORIZED } from '../src/http/live.js'

const logger = pino({ level: 'silent' })
const hello = JSON.stringify({
  type: 'hello',
  token: 'test-device-token-0001',
  appVersion: '0.1.0',
})

describe('http app', () => {
  const app = createApp({ logger })

  it('answers /healthz with ok and a wildcard CORS origin', async () => {
    const response = await app.request('/healthz', {
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers a CORS preflight with 204 and the allowed headers', async () => {
    const response = await app.request('/healthz', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const allowed = response.headers.get('access-control-allow-headers') ?? ''
    expect(allowed.toLowerCase().split(',')).toEqual([
      'authorization',
      'content-type',
    ])
  })
})

describe('live channel', () => {
  let server: Server | undefined

  afterEach(async () => {
    const current = server
    server = undefined
    if (!current) return
    current.closeAllConnections()
    await new Promise((resolve) => current.close(resolve))
  })

  async function connect(acceptDevTokens: boolean, path = '/ws') {
    const httpServer = serve({ fetch: createApp({ logger }).fetch, port: 0 })
    if (!(httpServer instanceof Server))
      throw new Error('expected an HTTP/1.1 server')
    server = httpServer
    attachLive(httpServer, { logger, acceptDevTokens, helloTimeoutMs: 200 })
    await once(httpServer, 'listening')
    const { port } = httpServer.address() as AddressInfo
    return new WebSocket(`ws://127.0.0.1:${port}${path}`)
  }

  async function closeCode(socket: WebSocket): Promise<number> {
    const [code] = (await once(socket, 'close')) as [number]
    return code
  }

  it('answers a dev hello with hello.ok', async () => {
    const socket = await connect(true)
    await once(socket, 'open')
    socket.send(hello)
    const [data] = (await once(socket, 'message')) as [Buffer]
    expect(JSON.parse(data.toString())).toEqual({ type: 'hello.ok' })
    socket.close()
  })

  it('closes with 4401 when no hello arrives in time', async () => {
    const socket = await connect(true)
    expect(await closeCode(socket)).toBe(CLOSE_UNAUTHORIZED)
  })

  it.each([
    ['invalid JSON', 'not json'],
    ['another frame type', JSON.stringify({ type: 'ping' })],
    [
      'a token under 16 chars',
      JSON.stringify({ type: 'hello', token: 'short', appVersion: '0.1.0' }),
    ],
  ])('closes with 4401 when the first frame is %s', async (_name, frame) => {
    const socket = await connect(true)
    await once(socket, 'open')
    socket.send(frame)
    expect(await closeCode(socket)).toBe(CLOSE_UNAUTHORIZED)
  })

  it('rejects every hello when dev tokens are disabled (production)', async () => {
    const socket = await connect(false)
    await once(socket, 'open')
    socket.send(hello)
    expect(await closeCode(socket)).toBe(CLOSE_UNAUTHORIZED)
  })

  it('refuses upgrades on other paths', async () => {
    const socket = await connect(true, '/other')
    const [error] = (await once(socket, 'error')) as [Error]
    expect(error.message).toMatch(/400/)
  })
})
