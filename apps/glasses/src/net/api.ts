// REST client for the Chairside server. The device token travels only as a
// bearer header; nothing here logs a token, a code or customer text.
import type { ActionRequest } from '@chairside/shared'
import {
  asActionResponse,
  asPairStart,
  asPairStatus,
  asServerFrame,
  type ActionResponse,
  type StateFrame,
} from './protocol'

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid'

export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(
    readonly kind: ApiErrorKind,
    readonly status?: number,
  ) {
    super(status ? `${kind} ${status}` : kind)
  }

  get unauthorized(): boolean {
    return this.status === 401
  }
}

export interface ActionResult {
  /** HTTP status: 200, or 409 when the card changed under the tap. */
  httpStatus: number
  response: ActionResponse
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 8_000
/** Booking runs free/busy, the insert, the overlap check and an 8 s send. */
const ACTION_TIMEOUT_MS = 25_000

export class ApiClient {
  readonly base: string

  constructor(
    base: string,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {
    this.base = base.replace(/\/+$/, '')
  }

  /** WebSocket URL of the live channel. */
  get liveUrl(): string {
    return `${this.base.replace(/^http/, 'ws')}/ws`
  }

  private async call(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    accept: (status: number) => boolean = (status) =>
      status >= 200 && status < 300,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch {
      throw new ApiError(controller.signal.aborted ? 'timeout' : 'network')
    } finally {
      clearTimeout(timer)
    }
    if (!accept(response.status)) throw new ApiError('http', response.status)
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body }
  }

  private static json(body: unknown, token?: string): RequestInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return { method: 'POST', headers, body: JSON.stringify(body) }
  }

  async pairStart(deviceNonce: string) {
    const { body } = await this.call(
      '/api/pair/start',
      ApiClient.json({ deviceNonce }),
      REQUEST_TIMEOUT_MS,
    )
    const parsed = asPairStart(body)
    if (!parsed) throw new ApiError('invalid')
    return parsed
  }

  async pairStatus(deviceNonce: string) {
    const { body } = await this.call(
      `/api/pair/status?nonce=${encodeURIComponent(deviceNonce)}`,
      { method: 'GET' },
      REQUEST_TIMEOUT_MS,
    )
    const parsed = asPairStatus(body)
    if (!parsed) throw new ApiError('invalid')
    return parsed
  }

  async state(token: string): Promise<StateFrame> {
    const { body } = await this.call(
      '/api/state',
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      REQUEST_TIMEOUT_MS,
    )
    const frame = asServerFrame(body)
    if (frame?.type !== 'state') throw new ApiError('invalid')
    return frame
  }

  async action(token: string, request: ActionRequest): Promise<ActionResult> {
    const { status, body } = await this.call(
      '/api/actions',
      ApiClient.json(request, token),
      ACTION_TIMEOUT_MS,
      (code) => code === 200 || code === 409,
    )
    const response = asActionResponse(body)
    if (!response) throw new ApiError('invalid', status)
    return { httpStatus: status, response }
  }
}
