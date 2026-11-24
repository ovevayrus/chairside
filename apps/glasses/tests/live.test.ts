import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/net/api'
import { LiveClient, type LinkState, type SocketLike } from '../src/net/live'
import type { ServerFrame, StateFrame } from '../src/net/protocol'

const TOKEN = 'device-token-0123456789abcdef'

class FakeSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  closedWith?: number
  private readonly listeners = new Map<string, ((event: never) => void)[]>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.closedWith = code
    this.readyState = 3
    this.emit('close', { code })
  }

  open(): void {
    this.readyState = 1
    this.emit('open', undefined)
  }

  receive(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }

  /** The server or the network ends the connection. */
  drop(code = 1006): void {
    this.readyState = 3
    this.emit('close', { code })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event as never)
  }
}

function state(seq: number): StateFrame {
  return {
    type: 'state',
    seq,
    root: {
      shopName: 'Shop',
      now: '2026-11-24T10:00:00.000Z',
      pendingCount: 0,
      mode: 'test',
    },
    cards: [],
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const frames: [ServerFrame, string][] = []
  const links: LinkState[] = []
  const unauthorized = vi.fn()
  const pollState = vi.fn<() => Promise<StateFrame>>(() =>
    Promise.reject(new ApiError('network')),
  )
  const client = new LiveClient({
    url: 'ws://localhost:8787/ws',
    token: TOKEN,
    appVersion: '0.1.0',
    pollState,
    onFrame: (frame, source) => frames.push([frame, source]),
    onLink: (link) => links.push(link),
    onUnauthorized: unauthorized,
    socket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  const last = () => sockets.at(-1)!
  const goLive = () => {
    last().open()
    last().receive({ type: 'hello.ok' })
  }
  return {
    client,
    sockets,
    frames,
    links,
    unauthorized,
    pollState,
    last,
    goLive,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('live channel', () => {
  it('sends the hello first, goes live on hello.ok and passes valid frames on', () => {
    const { client, last, links, frames, goLive } = setup()
    client.start()
    expect(last().url).toBe('ws://localhost:8787/ws')
    last().open()
    expect(last().sent.map((data) => JSON.parse(data))).toEqual([
      { type: 'hello', token: TOKEN, appVersion: '0.1.0' },
    ])
    // Nothing counts before the hello is accepted.
    last().receive(state(1))
    expect(frames).toEqual([])
    goLive()
    expect(links).toEqual(['live'])
    last().receive(state(2))
    last().receive({ type: 'card.upsert', seq: 3, card: { requestId: 'x' } })
    last().receive({ type: 'mystery', seq: 4 })
    expect(frames).toEqual([[state(2), 'socket']])
    client.stop()
  })

  it('reconnects with backoff 1 s, 2 s, 4 s, 8 s, then every 15 s', async () => {
    const { client, sockets, last } = setup()
    client.start()
    const delays: number[] = []
    for (let attempt = 0; attempt < 6; attempt++) {
      const count = sockets.length
      last().drop()
      let waited = 0
      while (sockets.length === count) {
        await vi.advanceTimersByTimeAsync(250)
        waited += 250
      }
      delays.push(waited)
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
    client.stop()
  })

  it('polls /api/state after two failed sockets and stops when the socket is back', async () => {
    const { client, sockets, last, links, frames, pollState, goLive } = setup()
    pollState.mockImplementation(() => Promise.resolve(state(5)))
    client.start()
    last().drop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pollState).not.toHaveBeenCalled()
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollState).toHaveBeenCalledTimes(1)
    expect(links).toEqual(['polling'])
    expect(frames).toEqual([[state(5), 'poll']])
    await vi.advanceTimersByTimeAsync(2000)
    expect(pollState).toHaveBeenCalledTimes(2)
    // The 2 s backoff produced a third socket; once it is live, polling ends.
    expect(sockets).toHaveLength(3)
    goLive()
    expect(links.at(-1)).toBe('live')
    const polls = pollState.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pollState).toHaveBeenCalledTimes(polls)
    client.stop()
  })

  it('reports offline when the socket and polling both fail', async () => {
    const { client, last, links } = setup()
    client.start()
    last().drop()
    await vi.advanceTimersByTimeAsync(1000)
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(links).toEqual(['offline'])
    client.stop()
  })

  it('treats close code 4401 as a rejected token and never reconnects', async () => {
    const { client, sockets, last, unauthorized } = setup()
    client.start()
    last().open()
    last().drop(4401)
    expect(unauthorized).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('treats HTTP 401 from polling as a rejected token', async () => {
    const { client, last, unauthorized, pollState } = setup()
    pollState.mockImplementation(() =>
      Promise.reject(new ApiError('http', 401)),
    )
    client.start()
    last().drop()
    await vi.advanceTimersByTimeAsync(1000)
    last().drop()
    await vi.advanceTimersByTimeAsync(0)
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })

  it('closes a socket that never answers the hello and tries again', async () => {
    const { client, sockets, last } = setup()
    client.start()
    last().open()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sockets[0]!.closedWith).toBe(4000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)
    client.stop()
  })

  it('drops a silent live socket after 75 s and reconnects at once', async () => {
    const { client, sockets, goLive, last } = setup()
    client.start()
    goLive()
    await vi.advanceTimersByTimeAsync(60_000)
    last().receive(state(1))
    await vi.advanceTimersByTimeAsync(74_000)
    expect(sockets[0]!.closedWith).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sockets[0]!.closedWith).toBe(4000)
    // (The fake clock runs a 0 ms timer set inside another timer 1 ms later.)
    await vi.advanceTimersByTimeAsync(10)
    expect(sockets).toHaveLength(2)
    client.stop()
  })

  it('resync reopens a live socket for a fresh state; stop closes everything', async () => {
    const { client, sockets, goLive } = setup()
    client.start()
    goLive()
    client.resync()
    expect(sockets[0]!.closedWith).toBe(1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    client.stop()
    expect(sockets[1]!.closedWith).toBe(1000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(2)
  })
})
