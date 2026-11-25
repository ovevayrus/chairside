// Chairside on the glasses: pairing, the live channel and one card at a time.
// Everything the platform provides (bridge, network, timers, randomness) comes
// in through AppPlatform, so the whole flow runs in unit tests (tests/app.test.ts).
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { logSharedGesture, normalizeEvent, type GlassesInput } from './input'
import { ApiError, type ApiClient } from './net/api'
import type { LinkState, LiveOptions } from './net/live'
import type {
  ActionResponse,
  Card,
  RootState,
  ServerFrame,
} from './net/protocol'
import { cardScreen } from './screens/card'
import { pairScreen } from './screens/pair'
import { receiptScreen } from './screens/receipt'
import { rootScreen } from './screens/root'
import { statusScreen } from './screens/status'
import { KEYS, type KeyValueStore } from './storage'
import type { Page, ScreenName } from './ui/layout'
import { StartupError, type MenuItem } from './ui/render'

export const RECEIPT_MS = 2_000
export const FLASH_MS = 2_000
export const PAIR_POLL_MS = 2_000
export const PAUSE_MS = 30 * 60_000
const TICK_MS = 30_000
const REDRAW_MS = 1_000
/** Receipt frames for an action this device just ran are already on screen. */
const OWN_RECEIPT_WINDOW_MS = 15_000
export const MENU = { refresh: 1, pause: 2 } as const

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

export interface LiveHandle {
  start(): void
  stop(): void
  resync(): void
}

export interface AppPlatform {
  /** Shows a page (startup page first, then upgrades or rebuilds). */
  show(page: Page, menu: MenuItem[]): Promise<unknown>
  /** The next show() rebuilds the whole page. */
  invalidate(): void
  /** Root double-tap: the system exit dialog (shutDownPageContainer(1)). */
  exit(): Promise<void>
  storage: KeyValueStore
  api: Pick<
    ApiClient,
    'pairStart' | 'pairStatus' | 'state' | 'action' | 'liveUrl'
  >
  createLive(options: LiveOptions): LiveHandle
  timers: Timers
  now(): number
  /** Hex string from a CSPRNG: device nonces and idempotency keys. */
  randomKey(bytes: number): string
  /** Writes "[chairside] <line>" to the console. */
  log(line: string): void
  /** Device-local "Tue 24 Nov" and "14:05". */
  formatDate(ms: number): string
  formatTime(ms: number): string
}

export interface AppConfig {
  appVersion: string
  /** Bot username shown on the pairing screen, when the build knows it. */
  bot?: string
  /**
   * Dev builds only: asks a TEST MODE server for its mode before the first
   * frame (production builds leave it out, so they never call /dev/*).
   */
  probeTestMode?: () => Promise<boolean>
}

/** Whole minutes, rounded; 0 once less than a minute is left. */
function minutesLeft(ms: number): number {
  return ms < 60_000 ? 0 : Math.round(ms / 60_000)
}

type View =
  | { name: 'pair' }
  | { name: 'root' }
  | { name: 'card'; requestId: string }
  | {
      name: 'receipt'
      title: string
      text: string
      detail?: string
      /** Return to this card afterwards (when it is still pending). */
      back?: string
    }
  | { name: 'status' }

type TimerName = 'receipt' | 'flash' | 'pair' | 'pause' | 'redraw'

interface PairState {
  nonce: string
  code?: string
  expiresAt?: number
  expired: boolean
  offline: boolean
}

export class ChairsideApp {
  private token = ''
  private test = false
  private root?: RootState
  private cards: Card[] = []
  private lastSeq = -1
  /** Highest version of each request already on screen: newer ones open by themselves. */
  private readonly seen = new Map<string, number>()
  private readonly logged = new Set<string>()
  private readonly notes = new Map<
    string,
    { version: number; text: string; alert: boolean }
  >()
  private readonly recent = new Map<string, number>()
  /** Idempotency keys of this device's own actions, and when each last changed. */
  private readonly ownKeys = new Map<string, number>()
  /** First line (who · what) of each card shown, for the "closed" receipt. */
  private readonly shownLines = new Map<string, string>()
  private receipts: { title: string; text: string }[] = []
  private pausedUntil = 0
  private calendarError = false
  private firstSync = true
  private inflight?: { card: Card; actionId: string }
  private flash?: { screen: ScreenName; text: string }
  private view: View = { name: 'root' }
  private beforeStatus: View = { name: 'root' }
  private pair: PairState = { nonce: '', expired: false, offline: false }
  private live?: LiveHandle
  private readonly timers = new Map<TimerName, unknown>()
  private tick?: unknown
  private rendering: Promise<void> = Promise.resolve()
  private renderQueued = false
  private ready = false
  private screenLogged?: ScreenName
  private receiptLogged?: View
  private closed = false

  constructor(
    private readonly p: AppPlatform,
    private readonly config: AppConfig,
  ) {}

  /** Reads the stored token, shows the first page and starts pairing or the live channel. */
  async start(): Promise<void> {
    this.token = await this.p.storage.get(KEYS.token)
    const paused = Number(await this.p.storage.get(KEYS.pausedUntil))
    if (Number.isFinite(paused) && paused > this.p.now()) {
      this.pausedUntil = paused
      this.schedulePauseEnd()
    }
    this.test = (await this.p.storage.get(KEYS.mode)) === 'test'
    // Dev builds ask a TEST MODE server before the first frame, so even the
    // pairing screen says TEST; after that every state frame says the mode.
    if (this.config.probeTestMode && !this.test)
      this.test = await this.config.probeTestMode().catch(() => false)
    this.tick = this.p.timers.setInterval(() => this.render(), TICK_MS)
    if (this.token) {
      this.view = { name: 'root' }
      this.render()
      this.connect()
    } else {
      this.startPairing()
    }
    await this.rendering
  }

  /** Every bridge event goes here (bridge.onEvenHubEvent). */
  handleEvent(event: EvenHubEvent): void {
    if (this.closed) return
    if (event.menuItemClickEvent) {
      this.menuClick(event.menuItemClickEvent.itemID ?? 0)
      return
    }
    const input = normalizeEvent(event)
    if (!input) return
    if (logSharedGesture(input)) {
      if (input.kind === 'foreground_enter') {
        // Android may have suspended the WebView: redraw and resync from scratch.
        this.p.invalidate()
        this.live?.resync()
        this.render()
      } else if (
        input.kind === 'system_exit' ||
        input.kind === 'abnormal_exit'
      ) {
        this.shutdown()
      }
      return
    }
    if (
      input.kind === 'click' ||
      input.kind === 'double_click' ||
      input.kind === 'scroll_up' ||
      input.kind === 'scroll_down'
    )
      this.gesture(input)
  }

  // ---- rendering ----------------------------------------------------------

  private render(): void {
    if (this.closed || this.renderQueued) return
    this.renderQueued = true
    this.rendering = this.rendering.then(async () => {
      this.renderQueued = false
      if (this.closed) return
      const view = this.view
      const { page, card } = this.page()
      try {
        await this.p.show(page, this.menu())
      } catch (error) {
        this.p.log(
          error instanceof StartupError
            ? error.message
            : `render failed screen=${page.screen}`,
        )
        // A lost bridge reply must not leave a stale page: draw again soon.
        if (!(error instanceof StartupError))
          this.setTimer('redraw', REDRAW_MS, () => this.render())
        return
      }
      if (!this.ready) {
        this.ready = true
        this.p.log('ready')
      }
      if (page.screen !== this.screenLogged) {
        this.screenLogged = page.screen
        this.p.log(`screen=${page.screen}`)
      }
      // Once per receipt, after it is drawn: two receipts in a row log one
      // screen change. Titles are fixed words, never customer text.
      if (view.name === 'receipt' && view !== this.receiptLogged) {
        this.receiptLogged = view
        this.p.log(`receipt title=${view.title}`)
      }
      if (card) {
        const key = `${card.requestId}:${card.version}`
        if (!this.logged.has(key)) {
          this.logged.add(key)
          this.p.log(`card shown req=${card.requestId} v=${card.version}`)
        }
      }
    })
  }

  private menu(): MenuItem[] {
    return [
      { id: MENU.refresh, label: 'Refresh' },
      {
        id: MENU.pause,
        label: this.paused() ? 'Resume cards' : 'Pause cards 30 min',
      },
    ]
  }

  private flashText(screen: ScreenName): string | undefined {
    return this.flash?.screen === screen ? this.flash.text : undefined
  }

  private page(): { page: Page; card?: Card } {
    const view = this.view
    const test = this.test
    switch (view.name) {
      case 'pair': {
        const { code, expiresAt, expired, offline } = this.pair
        return {
          page: pairScreen({
            test,
            code,
            expired,
            offline,
            bot: this.config.bot,
            flash: this.flashText('pair'),
            minutesLeft:
              expiresAt === undefined
                ? undefined
                : minutesLeft(expiresAt - this.p.now()),
          }),
        }
      }
      case 'card': {
        const card =
          this.inflight?.card.requestId === view.requestId
            ? this.inflight.card
            : this.card(view.requestId)
        if (card) {
          const note = this.notes.get(card.requestId)
          const index = this.cards.findIndex(
            (c) => c.requestId === card.requestId,
          )
          return {
            card,
            page: cardScreen({
              card,
              test,
              position: index >= 0 ? index + 1 : 1,
              total: Math.max(this.cards.length, 1),
              note:
                note?.version === card.version
                  ? { text: note.text, alert: note.alert }
                  : undefined,
            }),
          }
        }
        return { page: this.rootPage() }
      }
      case 'receipt':
        return {
          page: receiptScreen({
            test,
            title: view.title,
            text: view.text,
            detail: view.detail,
            hint: `${this.receiptHint(view)}  ·  Tap: now`,
          }),
        }
      case 'status':
        return {
          page: statusScreen({ test, flash: this.flashText('status') }),
        }
      default:
        return { page: this.rootPage() }
    }
  }

  private rootPage(): Page {
    return rootScreen({
      root: this.root,
      pending: this.cards.length,
      test: this.test,
      date: this.p.formatDate(this.p.now()),
      pausedUntil: this.paused()
        ? this.p.formatTime(this.pausedUntil)
        : undefined,
      flash: this.flashText('root'),
      calendarError: this.calendarError,
    })
  }

  private receiptHint(view: Extract<View, { name: 'receipt' }>): string {
    const seconds = Math.round(RECEIPT_MS / 1000)
    if (view.back && this.card(view.back))
      return `Back to the request in ${seconds} s`
    if (this.receipts.length > 0) return `More in ${seconds} s`
    if (!this.paused() && this.unseen()) return `Next request in ${seconds} s`
    return `Back to today in ${seconds} s`
  }

  private flashFor(screen: ScreenName, text: string): void {
    this.flash = { screen, text }
    this.render()
    this.setTimer('flash', FLASH_MS, () => {
      this.flash = undefined
      this.render()
    })
  }

  // ---- timers -------------------------------------------------------------

  private setTimer(name: TimerName, ms: number, handler: () => void): void {
    this.clearTimer(name)
    this.timers.set(
      name,
      this.p.timers.setTimeout(() => {
        this.timers.delete(name)
        handler()
      }, ms),
    )
  }

  private clearTimer(name: TimerName): void {
    const id = this.timers.get(name)
    if (id !== undefined) this.p.timers.clearTimeout(id)
    this.timers.delete(name)
  }

  private shutdown(): void {
    this.closed = true
    this.live?.stop()
    for (const name of [...this.timers.keys()]) this.clearTimer(name)
    if (this.tick !== undefined) this.p.timers.clearInterval(this.tick)
  }

  // ---- pairing ------------------------------------------------------------

  private startPairing(): void {
    this.clearTimer('pair')
    this.pair = {
      nonce: this.p.randomKey(24),
      expired: false,
      offline: false,
    }
    this.view = { name: 'pair' }
    this.render()
    void this.requestCode(this.pair.nonce, 0)
  }

  private async requestCode(nonce: string, attempt: number): Promise<void> {
    try {
      const { code, expiresAt } = await this.p.api.pairStart(nonce)
      if (this.pair.nonce !== nonce) return
      this.pair = {
        nonce,
        code,
        expiresAt: Date.parse(expiresAt),
        expired: false,
        offline: false,
      }
      this.setTimer('pair', PAIR_POLL_MS, () => void this.pollPairing(nonce))
      this.render()
      await this.rendering
      this.p.log('pair code issued')
    } catch {
      if (this.pair.nonce !== nonce) return
      this.pair.offline = true
      this.render()
      const delay = Math.min(2_000 * 2 ** attempt, 15_000)
      this.setTimer(
        'pair',
        delay,
        () => void this.requestCode(nonce, attempt + 1),
      )
    }
  }

  private async pollPairing(nonce: string): Promise<void> {
    let status
    try {
      status = await this.p.api.pairStatus(nonce)
    } catch {
      if (this.pair.nonce !== nonce) return
      this.pair.offline = true
      this.render()
      this.setTimer('pair', PAIR_POLL_MS, () => void this.pollPairing(nonce))
      return
    }
    if (this.pair.nonce !== nonce) return
    this.pair.offline = false
    if (status.status === 'pending') {
      this.render()
      this.setTimer('pair', PAIR_POLL_MS, () => void this.pollPairing(nonce))
      return
    }
    if (status.status === 'expired') {
      this.pair.expired = true
      this.render()
      return
    }
    if (!status.deviceToken) {
      // The token went to an earlier poll that never finished: start over.
      this.startPairing()
      return
    }
    this.token = status.deviceToken
    this.pair = { nonce: '', expired: false, offline: false }
    await this.p.storage.set(KEYS.token, this.token)
    this.p.log('paired')
    this.firstSync = true
    this.view = { name: 'root' }
    this.render()
    this.connect()
  }

  // ---- live channel -------------------------------------------------------

  private connect(): void {
    this.live?.stop()
    const token = this.token
    this.live = this.p.createLive({
      url: this.p.api.liveUrl,
      token,
      appVersion: this.config.appVersion,
      pollState: () => this.p.api.state(token),
      onFrame: (frame) => this.onFrame(frame),
      onLink: (state) => this.onLink(state),
      onUnauthorized: () => this.onUnauthorized(),
    })
    this.live.start()
  }

  private onUnauthorized(): void {
    this.p.log('device token rejected · pairing again')
    this.live?.stop()
    this.live = undefined
    this.token = ''
    void this.p.storage.set(KEYS.token, '')
    this.root = undefined
    this.cards = []
    this.lastSeq = -1
    this.inflight = undefined
    this.firstSync = true
    this.startPairing()
  }

  private onLink(state: LinkState): void {
    this.p.log(`link=${state}`)
    if (state === 'offline') {
      if (this.view.name === 'pair' || this.inflight) return
      if (this.view.name !== 'status') {
        this.beforeStatus =
          this.view.name === 'card' ? this.view : { name: 'root' }
        this.clearTimer('receipt')
        this.view = { name: 'status' }
      }
      this.render()
      return
    }
    if (this.view.name === 'status' && state !== 'connecting') {
      this.view = this.beforeStatus
      this.reconcile()
    }
  }

  private onFrame(frame: ServerFrame): void {
    if (frame.type === 'state') {
      this.lastSeq = frame.seq
      this.root = frame.root
      const test = frame.root.mode === 'test'
      if (test !== this.test) {
        this.test = test
        void this.p.storage.set(KEYS.mode, frame.root.mode)
      }
      this.cards = [...frame.cards]
      this.calendarError = false
      if (this.firstSync) {
        // Cards waiting at start-up are counted on root, not thrown at the owner.
        this.firstSync = false
        for (const card of this.cards) this.markSeen(card)
      }
    } else {
      if (frame.seq <= this.lastSeq) return
      this.lastSeq = frame.seq
      switch (frame.type) {
        case 'card.upsert':
          this.upsert(frame.card)
          break
        case 'card.remove':
          this.cards = this.cards.filter((c) => c.requestId !== frame.requestId)
          break
        case 'receipt':
          if (!this.ownReceipt(frame.requestId, frame.idempotencyKey))
            this.receipts.push({ title: 'Update', text: frame.text })
          break
        case 'error':
          if (frame.code === 'calendar_unavailable') this.calendarError = true
          break
      }
    }
    this.reconcile()
  }

  /**
   * True when a receipt frame is the outcome of this device's own action,
   * which it already showed from the HTTP answer. A frame that names its
   * action is matched by key, so a customer's "yes" to an offer sent from
   * here a moment ago still shows; an unnamed one falls back to the request.
   */
  private ownReceipt(requestId?: string, idempotencyKey?: string): boolean {
    if (idempotencyKey !== undefined) return this.ownKeys.has(idempotencyKey)
    return this.ownAction(requestId)
  }

  private ownAction(requestId: string | undefined): boolean {
    if (!requestId) return false
    if (this.inflight?.card.requestId === requestId) return true
    const at = this.recent.get(requestId)
    return at !== undefined && this.p.now() - at < OWN_RECEIPT_WINDOW_MS
  }

  /** Moves the view to match the data: closed cards leave, new cards open. */
  private reconcile(): void {
    const view = this.view
    if (
      view.name === 'card' &&
      this.inflight?.card.requestId !== view.requestId
    ) {
      const card = this.card(view.requestId)
      if (!card) {
        const gone = this.lastShown(view.requestId)
        this.showReceipt({
          title: 'Closed',
          text: '○ Closed outside the glasses',
          detail: gone,
        })
        return
      }
      this.markSeen(card)
    }
    if (view.name === 'root' && !this.paused()) {
      const receipt = this.receipts.shift()
      if (receipt) {
        this.showReceipt(receipt)
        return
      }
      const next = this.unseen()
      if (next) {
        this.openCard(next.requestId)
        return
      }
    }
    this.render()
  }

  // ---- cards --------------------------------------------------------------

  private card(requestId: string): Card | undefined {
    return this.cards.find((c) => c.requestId === requestId)
  }

  private lastShown(requestId: string): string | undefined {
    return this.shownLines.get(requestId)
  }

  private upsert(card: Card): void {
    const index = this.cards.findIndex((c) => c.requestId === card.requestId)
    if (index === -1) this.cards.push(card)
    else if (this.cards[index]!.version <= card.version)
      this.cards[index] = card
  }

  private markSeen(card: Card): void {
    if ((this.seen.get(card.requestId) ?? 0) < card.version)
      this.seen.set(card.requestId, card.version)
    if (card.lines[0]) this.shownLines.set(card.requestId, card.lines[0])
  }

  private unseen(): Card | undefined {
    return this.cards.find((c) => c.version > (this.seen.get(c.requestId) ?? 0))
  }

  private paused(): boolean {
    return this.pausedUntil > this.p.now()
  }

  private openCard(requestId: string): void {
    this.clearTimer('receipt')
    const card = this.card(requestId)
    if (card) this.markSeen(card)
    this.view = { name: 'card', requestId }
    this.render()
  }

  private goRoot(): void {
    // Going back is a choice: what is pending now waits on root.
    for (const card of this.cards) this.markSeen(card)
    this.clearTimer('receipt')
    this.view = { name: 'root' }
    this.reconcile()
  }

  private showReceipt(
    receipt: Omit<Extract<View, { name: 'receipt' }>, 'name'>,
  ) {
    this.view = { name: 'receipt', ...receipt }
    this.render()
    this.setTimer('receipt', RECEIPT_MS, () => this.advance())
  }

  private advance(): void {
    this.clearTimer('receipt')
    const view = this.view
    if (view.name !== 'receipt') return
    if (view.back && this.card(view.back)) {
      this.openCard(view.back)
      return
    }
    this.view = { name: 'root' }
    this.reconcile()
  }

  private async act(requestId: string, index: number): Promise<void> {
    if (this.inflight) return
    const card = this.card(requestId)
    const action = card?.actions[index]
    if (!card || !action) return
    this.inflight = { card, actionId: action.id }
    this.notes.set(requestId, {
      version: card.version,
      text: 'Sending...',
      alert: false,
    })
    this.render()
    this.p.log(`action sent req=${requestId} action=${action.id}`)
    // Known before the request goes out: the server's receipt frame for it
    // can arrive before the HTTP answer.
    const idempotencyKey = this.p.randomKey(16)
    this.ownKeys.set(idempotencyKey, this.p.now())
    let response: ActionResponse
    let answered = false
    try {
      ;({ response } = await this.p.api.action(this.token, {
        requestId,
        version: card.version,
        actionId: action.id,
        idempotencyKey,
      }))
      answered = true
    } catch (error) {
      this.inflight = undefined
      this.notes.delete(requestId)
      if (error instanceof ApiError && error.unauthorized) {
        this.onUnauthorized()
        return
      }
      this.p.log(`action result req=${requestId} status=unconfirmed`)
      this.showReceipt({
        title: 'Not confirmed',
        text: '○ No answer from Chairside',
        detail: 'Tap the action again to check',
        back: requestId,
      })
      return
    } finally {
      const now = this.p.now()
      for (const [id, at] of this.recent)
        if (now - at >= OWN_RECEIPT_WINDOW_MS) this.recent.delete(id)
      for (const [key, at] of this.ownKeys)
        if (now - at >= OWN_RECEIPT_WINDOW_MS) this.ownKeys.delete(key)
      if (answered) {
        this.recent.set(requestId, now)
        this.ownKeys.set(idempotencyKey, now)
      } else {
        // No answer reached the glasses: the server's receipt frame for this
        // action is now the only news of what happened, so let it show.
        this.ownKeys.delete(idempotencyKey)
      }
    }
    this.inflight = undefined
    this.notes.delete(requestId)
    this.p.log(`action result req=${requestId} status=${response.status}`)
    this.applyResult(card, response)
  }

  private applyResult(card: Card, response: ActionResponse): void {
    const { requestId } = card
    const who = card.lines[0]
    if (response.status === 'ok') {
      this.cards = this.cards.filter((c) => c.requestId !== requestId)
      this.showReceipt({
        title: 'Done',
        text: response.receipt ?? '● Done',
        detail: who,
      })
      return
    }
    if (response.status === 'reply_unknown') {
      if (response.card) {
        this.upsert(response.card)
        this.markSeen(response.card)
      }
      this.showReceipt({
        title: 'Check Telegram',
        text: response.receipt ?? 'Reply status unknown',
        detail: who,
      })
      return
    }
    const notes: Partial<Record<ActionResponse['status'], string>> = {
      slot_taken: 'Just taken · nothing sent',
      stale: 'Changed · check again',
      send_failed: 'Reply failed',
      error: response.receipt ?? 'Not done',
    }
    if (response.card) {
      this.upsert(response.card)
      this.markSeen(response.card)
      const note = notes[response.status]
      if (note)
        this.notes.set(requestId, {
          version: response.card.version,
          text: note,
          alert: true,
        })
      this.view = { name: 'card', requestId: response.card.requestId }
      this.render()
      return
    }
    if (response.status === 'stale') {
      this.cards = this.cards.filter((c) => c.requestId !== requestId)
      this.showReceipt({
        title: 'Closed',
        text: '○ Already handled',
        detail: who,
      })
      return
    }
    this.showReceipt({
      title: 'Not done',
      text: response.receipt ?? 'Something went wrong',
      detail: who,
      back: requestId,
    })
  }

  // ---- input --------------------------------------------------------------

  private gesture(input: GlassesInput): void {
    const { kind } = input
    const view = this.view
    this.p.log(`gesture=${kind} screen=${view.name}`)
    switch (view.name) {
      case 'pair':
        if (kind === 'double_click') {
          void this.p.exit()
        } else if (
          kind === 'click' &&
          (this.pair.expired || this.pair.offline)
        ) {
          this.startPairing()
        } else {
          this.flashFor(
            'pair',
            this.pair.code
              ? `Waiting for /pair ${this.pair.code} in Telegram`
              : 'Getting a code...',
          )
        }
        return
      case 'root':
        if (kind === 'double_click') {
          void this.p.exit()
        } else if (kind === 'click') {
          const first = this.cards[0]
          if (first) this.openCard(first.requestId)
          else this.flashFor('root', '○ Nothing to open right now')
        } else {
          this.live?.resync()
          this.flashFor('root', '▷ Refreshing...')
        }
        return
      case 'card':
        // While an action runs, the header says so; other taps wait for the answer.
        if (this.inflight) return
        if (kind === 'double_click') this.goRoot()
        else if (kind === 'click' && input.source === 'list')
          void this.act(view.requestId, input.index ?? 0)
        return
      case 'receipt':
        if (kind === 'double_click') this.goRoot()
        else this.advance()
        return
      case 'status':
        if (kind === 'double_click') {
          void this.p.exit()
        } else {
          this.live?.resync()
          this.flashFor('status', 'Retrying now...')
        }
        return
    }
  }

  private menuClick(id: number): void {
    this.p.log(`menu item=${id}`)
    if (id === MENU.refresh) {
      this.live?.resync()
      if (this.view.name === 'root') this.flashFor('root', '▷ Refreshing...')
      return
    }
    if (id !== MENU.pause) return
    const resume = this.paused()
    this.pausedUntil = resume ? 0 : this.p.now() + PAUSE_MS
    void this.p.storage.set(KEYS.pausedUntil, String(this.pausedUntil))
    this.schedulePauseEnd()
    if (this.view.name === 'root')
      this.flashFor(
        'root',
        resume
          ? '● Cards back on'
          : `■ Cards paused until ${this.p.formatTime(this.pausedUntil)}`,
      )
    else this.render()
    if (resume) this.reconcile()
  }

  private schedulePauseEnd(): void {
    this.clearTimer('pause')
    if (!this.paused()) return
    this.setTimer('pause', this.pausedUntil - this.p.now(), () => {
      this.pausedUntil = 0
      void this.p.storage.set(KEYS.pausedUntil, '0')
      this.reconcile()
    })
  }
}
