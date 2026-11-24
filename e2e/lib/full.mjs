// The full simulator run (US-011): pairing, root feedback, the contextual
// menu (pause and resume cards), a DM that becomes a card, one tap that books
// it (exactly 1 fake send + 1 fake event), the receipt and root,
// the stale-slot case (a calendar block lands while the card is on screen:
// slot_taken card, 0 new sends, 0 new events), a backend restart (status
// screen, then resync), and the root double-tap exit request. Every step
// saves a screenshot to docs/evidence/ and docs/evidence/e2e-full.md.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { compare, litPixels } from './frames.mjs'
import {
  appLog,
  appUrl,
  consoleMatch,
  launchSimulator,
  root,
  settledFrame,
  simulatorLines,
  step,
} from './harness.mjs'
import { linesSince, stop, waitFor } from './processes.mjs'

const evidenceDir = join(root, 'docs', 'evidence')
const MIN_LIT = 500
const CARD_TIMEOUT_MS = 12_000

const shop = JSON.parse(
  readFileSync(join(root, 'config', 'shop.demo.json'), 'utf8'),
)

/** UTC offset in minutes of the shop's time zone at `date`. */
function offsetMinutes(date) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: shop.timezone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName').value
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name)
  if (!match) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3])
  return match[1] === '-' ? -minutes : minutes
}

/** The shop-local calendar date of an instant, as a UTC-midnight Date. */
function shopDay(instant) {
  const local = new Date(instant.getTime() + offsetMinutes(instant) * 60_000)
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  )
}

/** UTC instant of a shop-local wall time on `day` (a UTC-midnight Date). */
function shopTime(day, hour, minute = 0) {
  const guess = new Date(day.getTime() + (hour * 60 + minute) * 60_000)
  return new Date(guess.getTime() - offsetMinutes(guess) * 60_000)
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

/** The first Saturday at least two days ahead (the demo shop opens Saturdays). */
function bookingDay(now) {
  const today = shopDay(now)
  let day = new Date(today.getTime() + 2 * 86_400_000)
  while (day.getUTCDay() !== 6) day = new Date(day.getTime() + 86_400_000)
  return day
}

const spoken = (day) =>
  `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`

function save(name, frame) {
  writeFileSync(join(evidenceDir, name), frame.png)
  return `docs/evidence/${name}`
}

function sends(fakes) {
  return fakes.telegram.calls.filter((call) =>
    ['sendText', 'sendWithButton'].includes(call.method),
  )
}

class Scenario {
  constructor(simulator, backend) {
    this.simulator = simulator
    this.backend = backend
    this.steps = []
    this.checks = []
    this.frame = undefined
    this.sim = undefined
    this.proc = undefined
    this.startedAt = Date.now()
  }

  check(ok, label) {
    this.checks.push({ ok, label })
    if (!ok) throw new Error(`check failed: ${label}`)
  }

  /** Waits for an app console line matching `pattern` after entry index `from`. */
  log(what, pattern, from, timeoutMs = 10_000) {
    return consoleMatch(this.sim, what, pattern, from, timeoutMs)
  }

  mark() {
    return this.sim.entries.length
  }

  /** Settled screenshot (after the display left the previous frame), saved as evidence. */
  async shot(name, detail, { minLit = MIN_LIT, changed = true } = {}) {
    const number = String(this.steps.length + 1).padStart(2, '0')
    const frame = await settledFrame(this.sim, changed ? this.frame : undefined)
    const file = `e2e-full-${number}-${name}.png`
    const path = save(file, frame)
    const lit = litPixels(frame)
    this.frame = frame
    this.steps.push({ number, name, detail, path, lit })
    step(`${number} ${name}: ${detail} (${lit} lit px)`)
    if (minLit)
      this.check(
        lit > minLit,
        `${file} has more than ${minLit} lit pixels (got ${lit})`,
      )
    return frame
  }

  async launch(url) {
    const { sim, proc, readyMs } = await launchSimulator(this.simulator, url)
    this.sim = sim
    this.proc = proc
    this.readyMs = readyMs
    this.check(
      readyMs <= 10_000,
      `[chairside] ready within 10 s (${readyMs} ms)`,
    )
  }

  async run() {
    const { backend } = this
    const now = new Date()
    const day = bookingDay(now)
    // Today's appointments for the root screen: two Chairside bookings ahead of now.
    const first = new Date(
      Math.ceil((now.getTime() + 15 * 60_000) / 300_000) * 300_000,
    )
    const second = new Date(first.getTime() + 30 * 60_000)
    const midnight = new Date(
      shopDay(now).getTime() + 86_400_000 - offsetMinutes(now) * 60_000,
    )
    const seeded = []
    for (const [start, name, serviceId, minutes] of [
      [first, 'Sami', 'haircut', 45],
      [second, 'Yusuf', 'beard_trim', 20],
    ]) {
      if (start < midnight) {
        await backend.dev('POST', '/dev/calendar/event', {
          startUtc: start.toISOString(),
          minutes,
          name,
          serviceId,
        })
        seeded.push(name)
      }
    }
    this.seeded = seeded

    // 1. First run: the pairing screen with a code.
    await this.launch(`${appUrl}/?fresh=1`)
    await this.log(
      '[chairside] pair code issued',
      /\[chairside\] pair code issued/,
      0,
    )
    await this.shot(
      'pair',
      'first run shows the pairing steps and a 6-character code',
    )

    // 2. Auto-pair through the dev endpoint; the token is stored and root opens.
    let mark = this.mark()
    const pairedAt = Date.now()
    const pair = await backend.dev('POST', '/dev/pair')
    this.check(pair.paired === true, '/dev/pair bound the code on screen')
    await this.log('[chairside] paired', /\[chairside\] paired$/, mark)
    await this.log('[chairside] screen=root', /\[chairside\] screen=root/, mark)
    await this.log('[chairside] link=live', /\[chairside\] link=live/, mark)
    this.pairMs = Date.now() - pairedAt
    await this.shot(
      'root',
      `paired in ${this.pairMs} ms; root shows Next/Then and no requests`,
    )

    // 2b. Visible feedback: a tap with nothing waiting says so.
    mark = this.mark()
    await this.sim.input('click')
    await this.log(
      'gesture=click screen=root',
      /gesture=click screen=root/,
      mark,
    )
    await this.shot(
      'root-tap-feedback',
      'tap on root with nothing waiting shows feedback',
    )

    // 2c. The contextual menu (carried on every page): pause cards, then resume.
    mark = this.mark()
    let menuMark = this.proc.total
    await this.sim.input('context_menu')
    await this.shot(
      'menu',
      'the system contextual menu shows Refresh and Pause cards 30 min',
      {
        minLit: 0,
      },
    )
    await this.sim.input('down')
    await delay(300)
    await this.sim.input('click')
    await this.log('[chairside] menu item=2', /\[chairside\] menu item=2/, mark)
    await this.shot('paused', 'Pause cards 30 min: root says cards are paused')
    await waitFor(
      'the rebuilt page to carry the menu with "Resume cards"',
      5_000,
      async () =>
        linesSince(this.proc, menuMark).some((line) =>
          /item_name: "Resume cards"/.test(line),
        ),
    )
    this.check(
      true,
      'every rebuild carries the menu: after pausing it reads "Resume cards"',
    )
    mark = this.mark()
    menuMark = this.proc.total
    await this.sim.input('context_menu')
    await delay(800)
    await this.sim.input('down')
    await delay(300)
    await this.sim.input('click')
    await this.log('[chairside] menu item=2', /\[chairside\] menu item=2/, mark)
    await waitFor(
      'the rebuilt page to carry "Pause cards 30 min" again',
      5_000,
      async () =>
        linesSince(this.proc, menuMark).some((line) =>
          /item_name: "Pause cards 30 min"/.test(line),
        ),
    )
    this.menuLog = appLog(this.sim, mark)

    // 3. A DM arrives: the card opens by itself.
    const before = await backend.fakes()
    mark = this.mark()
    const injectedAt = Date.now()
    await backend.dev('POST', '/dev/inject', {
      firstName: 'Anna',
      text: `Can I get a skin fade ${spoken(day)} at 3pm?`,
    })
    const shown = await this.log(
      '[chairside] card shown req=<id> v=1',
      /\[chairside\] card shown req=(\S+) v=1\b/,
      mark,
      CARD_TIMEOUT_MS,
    )
    this.cardMs = Date.now() - injectedAt
    const requestId = /req=(\S+)/.exec(shown.message)[1]
    await this.shot(
      'card',
      `DM to card in ${this.cardMs} ms (2.5 s debounce included); smart default highlighted`,
    )

    // 4. One tap books it: exactly 1 send and 1 event, then receipt and root.
    mark = this.mark()
    const tappedAt = Date.now()
    await this.sim.input('click')
    const sent = await this.log(
      '[chairside] action sent',
      new RegExp(`\\[chairside\\] action sent req=${requestId} action=\\S+`),
      mark,
    )
    const result = await this.log(
      '[chairside] action result',
      new RegExp(`\\[chairside\\] action result req=${requestId} status=\\w+`),
      mark,
      15_000,
    )
    this.tapMs = Date.now() - tappedAt
    this.check(
      /status=ok$/.test(result.message),
      `booking answered ok (${result.message})`,
    )
    await this.log(
      '[chairside] screen=receipt',
      /\[chairside\] screen=receipt/,
      mark,
    )
    await this.shot('receipt', `tap to receipt in ${this.tapMs} ms`)
    const after = await backend.fakes()
    const newSends = sends(after).length - sends(before).length
    const booked = after.calendar.events.filter(
      (event) => !before.calendar.events.some((old) => old.id === event.id),
    )
    const slot = shopTime(day, 15)
    this.check(
      newSends === 1,
      `the tap made exactly 1 fake Telegram send (got ${newSends})`,
    )
    this.check(
      booked.length === 1,
      `the tap made exactly 1 fake calendar event (got ${booked.length})`,
    )
    this.check(
      booked[0].summary === 'Chairside · Anna · Skin fade' &&
        Date.parse(booked[0].startUtc) === slot.getTime(),
      `the event is "Chairside · Anna · Skin fade" at ${slot.toISOString()} (got ${booked[0].summary} at ${booked[0].startUtc})`,
    )
    this.booking = {
      requestId,
      action: /action=(\S+)/.exec(sent.message)[1],
      event: booked[0],
      send: sends(after).at(-1),
    }
    await this.log(
      '[chairside] screen=root',
      /\[chairside\] screen=root/,
      mark,
      6_000,
    )
    await this.shot(
      'root-after-booking',
      'the receipt advanced to root by itself after 2 s',
    )

    // 5. Stale slot: a block lands while the card is on screen; the tap sends nothing.
    mark = this.mark()
    await backend.dev('POST', '/dev/inject', {
      firstName: 'Omar',
      text: `can you also do a beard trim ${spoken(day)} at 5pm?`,
    })
    const staleShown = await this.log(
      '[chairside] card shown req=<id> v=1',
      /\[chairside\] card shown req=(\S+) v=1\b/,
      mark,
      CARD_TIMEOUT_MS,
    )
    const staleId = /req=(\S+)/.exec(staleShown.message)[1]
    await this.shot('card-before-block', 'the 17:00 card shows the slot free')
    const blockStart = shopTime(day, 17)
    await backend.dev('POST', '/dev/calendar/block', {
      startUtc: blockStart.toISOString(),
      minutes: 30,
    })
    const beforeStale = await backend.fakes()
    mark = this.mark()
    await this.sim.input('click')
    const staleResult = await this.log(
      '[chairside] action result',
      new RegExp(`\\[chairside\\] action result req=${staleId} status=\\w+`),
      mark,
      15_000,
    )
    this.check(
      /status=slot_taken$/.test(staleResult.message),
      `the tap answered slot_taken (${staleResult.message})`,
    )
    await this.log(
      '[chairside] card shown req=<id> v=2',
      new RegExp(`\\[chairside\\] card shown req=${staleId} v=2\\b`),
      mark,
    )
    await this.shot(
      'slot-taken',
      'slot_taken card: header says nothing was sent, first action offers the next opening',
    )
    const afterStale = await backend.fakes()
    const staleSends = sends(afterStale).length - sends(beforeStale).length
    const staleEvents =
      afterStale.calendar.events.length - beforeStale.calendar.events.length
    this.check(
      staleSends === 0,
      `the stale tap made 0 fake sends (got ${staleSends})`,
    )
    this.check(
      staleEvents === 0,
      `the stale tap made 0 fake events (got ${staleEvents})`,
    )
    this.stale = { requestId: staleId, blockStart: blockStart.toISOString() }

    // 6. Double-tap on a card goes back to root (the request keeps waiting).
    mark = this.mark()
    await this.sim.input('double_click')
    await this.log('[chairside] screen=root', /\[chairside\] screen=root/, mark)
    await this.shot(
      'root-pending',
      'double-tap on the card went back to root; 1 request waiting',
    )

    // 7. The server goes away: status screen; it comes back: resync, no re-pairing.
    mark = this.mark()
    await backend.stop()
    const downAt = Date.now()
    await this.log(
      '[chairside] screen=status',
      /\[chairside\] screen=status/,
      mark,
      20_000,
    )
    this.statusMs = Date.now() - downAt
    await this.shot(
      'status',
      `backend stopped: status screen after ${this.statusMs} ms`,
    )
    mark = this.mark()
    await backend.start()
    const upAt = Date.now()
    await this.log(
      '[chairside] screen=root',
      /\[chairside\] screen=root/,
      mark,
      20_000,
    )
    this.resyncMs = Date.now() - upAt
    const relinked = appLog(this.sim, mark).filter((line) =>
      /link=|pair/.test(line),
    )
    this.check(
      !relinked.some((line) => /screen=pair|paired/.test(line)),
      'the restart did not ask to pair again',
    )
    this.relinked = relinked
    await this.shot(
      'root-reconnected',
      `backend back: root again after ${this.resyncMs} ms (${relinked.join(', ')})`,
    )

    // 8. Root double-tap asks the system for the exit dialog.
    mark = this.mark()
    const exitMark = this.proc.total
    const ready = this.frame
    await this.sim.input('double_click')
    await this.log(
      '[chairside] exit dialog requested',
      /\[chairside\] exit dialog requested/,
      mark,
    )
    await waitFor(
      'ShutDownPageContainer in the simulator log',
      5_000,
      async () =>
        linesSince(this.proc, exitMark).some((line) =>
          line.includes('ShutDownPageContainer'),
        ),
    )
    const exit = await this.shot(
      'exit',
      'root double-tap: shutDownPageContainer(1) requested',
      {
        minLit: 0,
      },
    )
    const { changed, box } = compare(ready, exit)
    this.exit = {
      changed,
      box,
      litBefore: litPixels(ready),
      litAfter: litPixels(exit),
    }
    await this.sim.input('click')
    await delay(500)
    this.exit.simulatorLog = [
      ...new Set(
        simulatorLines(
          { lines: linesSince(this.proc, exitMark) },
          /ShutDownPageContainer|no active event container/,
        ),
      ),
    ]
    this.exit.dialogDrawn = this.exit.litAfter > 0
    this.check(
      this.exit.dialogDrawn ||
        this.exit.simulatorLog.some((line) =>
          line.includes('no active event container'),
        ),
      'after the exit request the simulator either draws a dialog or has removed the page (0.9.5 draws none)',
    )
  }
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`
}

function report(scenario, simulatorVersion, error) {
  const s = scenario
  const code = (value) => `\`${value}\``
  const lines = [
    '# Simulator e2e: full run (US-011)',
    '',
    `Run ${new Date(s.startedAt).toISOString()} by ${code('npm run e2e')} (${code('e2e/run.mjs')}): backend in TEST MODE (${code('DEV_INJECT=1')}, fake Telegram, fake calendar, fresh temp database), Vite dev server, evenhub-simulator ${simulatorVersion} with ${code('--automation-port 9898')}, SDK 0.0.16, Node ${process.version} on ${process.platform}. Simulator only: nothing here ran on G2 hardware or against real Telegram or Google.`,
    '',
    `Result: **${error ? `FAIL: ${error}` : 'PASS'}**`,
    '',
    '## Steps',
    '',
    ...s.steps.map(
      (entry) =>
        `${entry.number}. **${entry.name}**: ${entry.detail}. ${entry.lit} lit px. ![${entry.name}](${entry.path.replace('docs/evidence/', '')})`,
    ),
    '',
    '## Checks',
    '',
    ...s.checks.map((check) => `- [${check.ok ? 'x' : ' '}] ${check.label}`),
    '',
    '## Details',
    '',
    `- Root appointments seeded for the screenshot: ${s.seeded?.length ? s.seeded.join(', ') : 'none (too close to midnight in the shop time zone)'}.`,
    `- Clocks: Next/Then and card times are shop-local (${shop.timezone}, from the server); the header date and the "paused until" time are device-local. This machine runs at UTC${formatOffset(-new Date().getTimezoneOffset())}, so they differ here; on a phone in the shop they agree.`,
  ]
  if (s.menuLog) {
    lines.push(
      `- Contextual menu: ${code('context_menu')} opened the system menu with the page's items; ${code('down')} + ${code('click')} chose "Pause cards 30 min" and the next rebuild carried the menu as "Resume cards"; choosing it again resumed cards (the rebuild carried "Pause cards 30 min" again). App lines while resuming: ${s.menuLog.map(code).join(', ')}.`,
    )
  }
  if (s.booking) {
    lines.push(
      `- Booking: request ${code(s.booking.requestId)}, action ${code(s.booking.action)}; fake calendar event ${code(s.booking.event.id)} "${s.booking.event.summary}" ${s.booking.event.startUtc} to ${s.booking.event.endUtc}; fake Telegram ${code(s.booking.send.method)} to chat ${s.booking.send.chatId}, message ${s.booking.send.messageId} (the fake keeps only a SHA-256 of the text).`,
      `- Timings: pair ${s.pairMs} ms; DM to card ${s.cardMs} ms (includes the 2.5 s debounce); tap to answer ${s.tapMs} ms.`,
    )
  }
  if (s.stale) {
    lines.push(
      `- Stale slot: request ${code(s.stale.requestId)}; a 30-minute foreign block inserted at ${s.stale.blockStart} while the card was on screen; the tap answered ${code('slot_taken')} with card version 2; fake sends and events unchanged.`,
    )
  }
  if (s.statusMs !== undefined) {
    lines.push(
      `- Reconnect: status screen ${s.statusMs} ms after the backend stopped; root again ${s.resyncMs} ms after it restarted (same database and pepper), without re-pairing. App lines: ${(s.relinked ?? []).map(code).join(', ') || 'none'}.`,
    )
  }
  if (s.exit) {
    lines.push(
      `- Exit: the app logged ${code('[chairside] exit dialog requested')} and called ${code('shutDownPageContainer(1)')}. Lit pixels ${s.exit.litBefore} before, ${s.exit.litAfter} after${s.exit.box ? ` (changed box x ${s.exit.box.x0}..${s.exit.box.x1}, y ${s.exit.box.y0}..${s.exit.box.y1})` : ''}. Simulator log: ${s.exit.simulatorLog.map(code).join(', ')}. ${s.exit.dialogDrawn ? 'A dialog was drawn.' : 'evenhub-simulator 0.9.5 draws no system exit dialog: it removes the page and ignores later input (docs/SPIKES.md S3), so the dialog and its cancel gesture need G2 hardware.'}`,
    )
  }
  lines.push('')
  writeFileSync(join(evidenceDir, 'e2e-full.md'), lines.join('\n'))
  step('wrote docs/evidence/e2e-full.md')
}

export async function fullRun(simulator, backend) {
  // Screenshots from an earlier run must not pass for this run's evidence.
  for (const file of readdirSync(evidenceDir))
    if (/^e2e-full-.*\.png$/.test(file)) rmSync(join(evidenceDir, file))
  const scenario = new Scenario(simulator, backend)
  let failure
  try {
    await scenario.run()
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (scenario.proc) await stop(scenario.proc)
    report(scenario, simulator.version, failure?.message.split('\n')[0])
  }
}
