import {
  ServerMessageSchema,
  type Card,
  type RootState,
  type ServerMessage,
  type SlotSummary,
} from '@chairside/shared'
import { DateTime } from 'luxon'
import { WebSocket } from 'ws'
import type { CalEvent, CalendarAdapter } from '../calendar/adapter.js'

interface LiveShop {
  name: string
  timezone: string
  mode: RootState['mode']
  calendar: CalendarAdapter
  pendingCards(): Card[]
}

type StateFrame = Extract<ServerMessage, { type: 'state' }>
type Sequenced = Exclude<ServerMessage, { type: 'hello.ok' }>
type WithoutSeq<T> = T extends Sequenced ? Omit<T, 'seq'> : never
type Delta = WithoutSeq<Exclude<Sequenced, StateFrame>>

interface Channel {
  seq: number
  ready: Set<WebSocket>
  snapshots: Promise<void>
}

function slotSummary(event: CalEvent, timezone: string): SlotSummary {
  const time = DateTime.fromISO(event.startUtc, { zone: timezone }).toFormat(
    'HH:mm',
  )
  const [prefix, name, service] = event.summary.split(' · ')
  if (
    event.privateProps.chairsideBookingId &&
    prefix === 'Chairside' &&
    name &&
    service
  ) {
    return { time, name: name.slice(0, 24), service: service.slice(0, 24) }
  }
  return { time, name: 'Busy', service: '' }
}

export class LiveHub {
  private readonly shops = new Map<string, Channel>()
  private readonly socketShops = new Map<WebSocket, string>()

  constructor(
    private readonly getShop: (shopId: string) => LiveShop,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private channel(shopId: string): Channel {
    let channel = this.shops.get(shopId)
    if (!channel) {
      channel = { seq: 0, ready: new Set(), snapshots: Promise.resolve() }
      this.shops.set(shopId, channel)
    }
    return channel
  }

  /** Called only once the transport authenticated the hello. */
  connect(shopId: string, socket: WebSocket): Promise<void> {
    this.socketShops.set(socket, shopId)
    socket.once('close', () => {
      this.socketShops.delete(socket)
      this.channel(shopId).ready.delete(socket)
    })
    return this.sendState(socket)
  }

  sendState(socket: WebSocket): Promise<void> {
    const shopId = this.socketShops.get(socket)
    if (!shopId) throw new Error('Unauthenticated live socket')
    return this.readState(shopId, (frame, calendarAvailable) => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify(frame))
      this.channel(shopId).ready.add(socket)
      if (!calendarAvailable) this.calendarError(shopId, [socket])
    })
  }

  broadcast(shopId: string, delta: Delta): void {
    const channel = this.channel(shopId)
    this.send(
      channel.ready,
      ServerMessageSchema.parse({ ...delta, seq: ++channel.seq }),
    )
  }

  broadcastState(shopId: string): Promise<void> {
    if (![...this.socketShops.values()].includes(shopId))
      return Promise.resolve()
    return this.readState(shopId, (frame, calendarAvailable) => {
      const sockets = this.channel(shopId).ready
      this.send(sockets, frame)
      if (!calendarAvailable) this.calendarError(shopId, sockets)
    })
  }

  async refreshConnected(): Promise<void> {
    await Promise.all(
      [...new Set(this.socketShops.values())].map((shopId) =>
        this.broadcastState(shopId),
      ),
    )
  }

  snapshot(shopId: string): Promise<StateFrame> {
    return this.readState(shopId, (frame) => frame)
  }

  private send(sockets: Iterable<WebSocket>, frame: ServerMessage): void {
    const json = JSON.stringify(frame)
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(json)
    }
  }

  private calendarError(shopId: string, sockets: Iterable<WebSocket>): void {
    this.send(
      sockets,
      ServerMessageSchema.parse({
        type: 'error',
        seq: ++this.channel(shopId).seq,
        code: 'calendar_unavailable',
        message: "Could not load today's appointments",
      }),
    )
  }

  // Order concurrent calendar reads. Capture cards and send the frame in one
  // synchronous turn after the calendar returns, so a late state cannot undo
  // a newer card.remove or card.upsert.
  private readState<T>(
    shopId: string,
    deliver: (frame: StateFrame, calendarAvailable: boolean) => T,
  ): Promise<T> {
    const channel = this.channel(shopId)
    const read = channel.snapshots.then(async () => {
      const shop = this.getShop(shopId)
      const now = this.now()
      const local = DateTime.fromJSDate(now, { zone: shop.timezone })
      const midnight = local.startOf('day').plus({ days: 1 }).toUTC().toISO()!
      let appointments: SlotSummary[] = []
      let calendarAvailable = true
      try {
        const events = await shop.calendar.listEvents(
          now.toISOString(),
          midnight,
        )
        appointments = events
          .filter((event) => Date.parse(event.startUtc) >= now.getTime())
          .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
          .slice(0, 2)
          .map((event) => slotSummary(event, shop.timezone))
      } catch {
        calendarAvailable = false
      }
      const cards = shop.pendingCards()
      const frame = ServerMessageSchema.parse({
        type: 'state',
        seq: ++channel.seq,
        cards,
        root: {
          shopName: shop.name.slice(0, 40),
          now: now.toISOString(),
          mode: shop.mode,
          next: appointments[0],
          then: appointments[1],
          pendingCount: cards.length,
        },
      })
      if (frame.type !== 'state') throw new Error('Expected a state frame')
      return deliver(frame, calendarAvailable)
    })
    channel.snapshots = read.then(
      () => {},
      () => {},
    )
    return read
  }
}
