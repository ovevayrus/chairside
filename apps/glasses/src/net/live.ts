// Live channel: a WebSocket (first frame { type: 'hello', token }) with
// reconnect backoff 1 s -> 15 s, and GET /api/state polling every 2 s once the
// socket has failed twice. Every (re)connect starts with a full state frame, so
// the app resyncs on each one. Close code 4401 or HTTP 401 means the device
// token is no longer valid.
import { ApiError } from './api'
import { asServerFrame, type ServerFrame, type StateFrame } from './protocol'

export type LinkState = 'connecting' | 'live' | 'polling' | 'offline'

export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const
export const HELLO_TIMEOUT_MS = 5_000
export const POLL_INTERVAL_MS = 2_000
/** Failed socket attempts before polling starts. */
export const POLL_AFTER_FAILURES = 2
/** The server refreshes every 60 s; this much silence means a dead socket. */
export const SILENCE_LIMIT_MS = 75_000
export const CLOSE_UNAUTHORIZED = 4401

/** The parts of the browser WebSocket this client uses (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void
  addEventListener(
    type: 'close',
    listener: (event: { code: number }) => void,
  ): void
  addEventListener(type: 'error', listener: () => void): void
}

export type SocketFactory = (url: string) => SocketLike

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export const browserTimers: Timers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (id) =>
    globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

export interface LiveOptions {
  url: string
  token: string
  appVersion: string
  pollState: () => Promise<StateFrame>
  onFrame: (frame: ServerFrame, source: 'socket' | 'poll') => void
  onLink: (state: LinkState) => void
  onUnauthorized: () => void
  socket?: SocketFactory
  timers?: Timers
}

const OPEN = 1

export class LiveClient {
  private readonly timers: Timers
  private readonly createSocket: SocketFactory
  private socket?: SocketLike
  private helloOk = false
  private stopped = true
  private attempt = 0
  private socketFailures = 0
  private polling = false
  private link: LinkState = 'connecting'
  private reconnectTimer?: unknown
  private helloTimer?: unknown
  private silenceTimer?: unknown
  private pollTimer?: unknown

  constructor(private readonly options: LiveOptions) {
    this.timers = options.timers ?? browserTimers
    this.createSocket =
      options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
  }

  get state(): LinkState {
    return this.link
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.setLink('connecting')
    this.connect()
  }

  stop(): void {
    this.stopped = true
    for (const timer of [
      this.reconnectTimer,
      this.helloTimer,
      this.silenceTimer,
      this.pollTimer,
    ])
      if (timer !== undefined) this.timers.clearTimeout(timer)
    this.reconnectTimer = this.helloTimer = this.silenceTimer = undefined
    this.pollTimer = undefined
    this.polling = false
    const socket = this.socket
    this.socket = undefined
    this.helloOk = false
    if (socket && socket.readyState <= OPEN) socket.close(1000)
  }

  /** Fresh state now: reopen the socket (the server sends state on hello), or poll. */
  resync(): void {
    if (this.stopped) return
    if (this.socket && this.helloOk) {
      this.socket.close(1000)
      return
    }
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      this.attempt = 0
      this.connect()
    }
    if (this.polling) this.poll()
  }

  private setLink(state: LinkState): void {
    if (this.link === state) return
    this.link = state
    this.options.onLink(state)
  }

  private unauthorized(): void {
    this.stop()
    this.options.onUnauthorized()
  }

  private connect(): void {
    this.reconnectTimer = undefined
    if (this.stopped) return
    let socket: SocketLike
    try {
      socket = this.createSocket(this.options.url)
    } catch {
      this.failed()
      return
    }
    this.socket = socket
    this.helloOk = false
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      socket.send(
        JSON.stringify({
          type: 'hello',
          token: this.options.token,
          appVersion: this.options.appVersion,
        }),
      )
      this.helloTimer = this.timers.setTimeout(() => {
        if (this.socket === socket && !this.helloOk) socket.close(4000)
      }, HELLO_TIMEOUT_MS)
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      let data: unknown
      try {
        data = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!this.helloOk) {
        if (
          typeof data === 'object' &&
          data !== null &&
          'type' in data &&
          data.type === 'hello.ok'
        )
          this.helloAccepted()
        return
      }
      this.armSilence(socket)
      const frame = asServerFrame(data)
      if (frame) this.options.onFrame(frame, 'socket')
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = undefined
      const wasLive = this.helloOk
      this.helloOk = false
      if (this.helloTimer !== undefined)
        this.timers.clearTimeout(this.helloTimer)
      if (this.silenceTimer !== undefined)
        this.timers.clearTimeout(this.silenceTimer)
      if (this.stopped) return
      if (event.code === CLOSE_UNAUTHORIZED) {
        this.unauthorized()
        return
      }
      // A clean resync (closed while live) reconnects at once.
      if (wasLive) this.attempt = 0
      this.failed(wasLive)
    })
    socket.addEventListener('error', () => {
      // The close event follows and decides what happens next.
    })
  }

  private helloAccepted(): void {
    if (this.helloTimer !== undefined) this.timers.clearTimeout(this.helloTimer)
    this.helloOk = true
    this.attempt = 0
    this.socketFailures = 0
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.polling = false
    this.setLink('live')
    if (this.socket) this.armSilence(this.socket)
  }

  private armSilence(socket: SocketLike): void {
    if (this.silenceTimer !== undefined)
      this.timers.clearTimeout(this.silenceTimer)
    this.silenceTimer = this.timers.setTimeout(() => {
      if (this.socket === socket) socket.close(4000)
    }, SILENCE_LIMIT_MS)
  }

  private failed(wasLive = false): void {
    if (this.stopped) return
    if (!wasLive) this.socketFailures += 1
    if (this.link === 'live') this.setLink('connecting')
    const delay = wasLive
      ? 0
      : BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    if (!wasLive) this.attempt += 1
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), delay)
    if (this.socketFailures >= POLL_AFTER_FAILURES && !this.polling) {
      this.polling = true
      this.poll()
    }
  }

  private poll(): void {
    if (this.pollTimer !== undefined) this.timers.clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    if (this.stopped || !this.polling) return
    this.options.pollState().then(
      (frame) => {
        // A socket that came back meanwhile is fresher than this answer.
        if (this.stopped || !this.polling || this.helloOk) return
        this.setLink('polling')
        this.options.onFrame(frame, 'poll')
        this.schedulePoll()
      },
      (error: unknown) => {
        if (this.stopped || !this.polling || this.helloOk) return
        if (error instanceof ApiError && error.unauthorized) {
          this.unauthorized()
          return
        }
        this.setLink('offline')
        this.schedulePoll()
      },
    )
  }

  private schedulePoll(): void {
    this.pollTimer = this.timers.setTimeout(() => this.poll(), POLL_INTERVAL_MS)
  }
}
