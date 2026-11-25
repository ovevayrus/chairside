// npm run smoke:live: the live end-to-end smoke (US-015) with real Telegram and
// real Google Calendar. It starts the server (real adapters, apps/server/.env),
// Vite and the Even Hub simulator, then walks the people through a pairing from
// scratch, the three demo moments and a reconnect. The runner taps the glasses
// and inserts the Moment 3 block itself; the people only send the Telegram
// messages it prints (lines starting "[smoke] >>>").
//
// Evidence: docs/evidence/live-smoke.md, live-smoke.json and live-smoke-*.png.
// It records ids, times, counts and statuses only: never message text, names,
// or Telegram user and chat ids.
//
//   npm run smoke:live                        booking day: first Saturday >= 2 days ahead
//   npm run smoke:live -- --day 2026-12-05    another day (free 14:00-18:30, shop open)
//   npm run smoke:live -- --pause 3           seconds each card stays up before the tap
//   npm run smoke:live -- --wait 10           minutes to wait for each person
//   npm run smoke:live -- --no-final-dm       skip the DM after the reconnect
//   npm run smoke:live -- --keep-demo         keep the seeded demo events and the block
//
// SHOP_CONFIG_PATH (relative to apps/server, from the shell or .env) picks the
// shop, e.g. ../../config/shop.recording.json.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import {
  blockSlot,
  formatLocal,
  resetDemo,
  seedDemoEvents,
} from '../apps/server/src/demo/index.ts'
import {
  appUrl,
  assertPortsFree,
  httpOk,
  launchSimulator,
  ports,
  root,
  settledFrame,
  startVite,
} from '../e2e/lib/harness.mjs'
import { start, stop, stopAll, waitFor } from '../e2e/lib/processes.mjs'
import { findSimulator } from '../e2e/lib/simulator.mjs'
import { demoContext } from './lib/demo-env.ts'
import {
  customerLines,
  defaultDay,
  entryTime,
  parseArgs,
  renderReport,
  secondsBetween,
  spokenDay,
} from './lib/smoke-report.mjs'

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const evidenceDir = join(root, 'docs', 'evidence')
const serverDir = join(root, 'apps', 'server')
const serverBase = `http://127.0.0.1:${ports.backend}`
const waitMs = options.waitMin * 60_000

const r = {
  startedAt: new Date().toISOString(),
  ok: false,
  env: {},
  checks: [],
  shots: [],
  timeline: [],
}

let calendar
let shop
let db
let sim
let server
let lastFrame
let lines
let started = false
let finishing = false

const say = (message) => console.log(`[smoke] ${message}`)
const ask = (message) => console.log(`\n[smoke] >>> ${message}\n`)
const iso = (ms) => new Date(ms).toISOString()

function mark(text) {
  r.timeline.push({ at: new Date().toISOString(), text })
  say(text)
}

/** A pass/fail line in the report; a failure stops the run. */
function check(ok, label) {
  r.checks.push({ ok, label })
  say(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) throw new Error(`check failed: ${label}`)
}

/** A pass/fail line that does not stop the run. */
function note(ok, label) {
  r.checks.push({ ok, label })
  say(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

// ---- time and calendar helpers (shop time zone) --------------------------

const localUtc = (day, hhmm) =>
  DateTime.fromISO(`${day}T${hhmm}`, { zone: shop.timezone }).toUTC().toISO()

function dayRange(day) {
  const start = DateTime.fromISO(day, { zone: shop.timezone }).startOf('day')
  return {
    startUtc: start.toUTC().toISO(),
    endUtc: start.plus({ days: 1 }).toUTC().toISO(),
  }
}

const local = (utc) =>
  DateTime.fromISO(utc, { zone: 'utc' })
    .setZone(shop.timezone)
    .toFormat('ccc d LLL HH:mm')

const interval = (startUtc, endUtc) =>
  `${local(startUtc)}-${DateTime.fromISO(endUtc, { zone: 'utc' }).setZone(shop.timezone).toFormat('HH:mm')}`

const sameInstant = (a, b) => Boolean(a && b) && Date.parse(a) === Date.parse(b)

async function dayEvents(day, excludeId) {
  const { startUtc, endUtc } = dayRange(day)
  const events = await calendar.listEvents(startUtc, endUtc)
  return events.filter((event) => event.id !== excludeId)
}

/** Reads an event back from Google Calendar and compares its interval. */
async function verifyEvent(id, startUtc, endUtc) {
  const event = await calendar.getEvent(id)
  return (
    Boolean(event) &&
    sameInstant(event.startUtc, startUtc) &&
    sameInstant(event.endUtc, endUtc)
  )
}

// ---- the server's database (read-only) -----------------------------------

const get = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)

function maxUpdateId() {
  return get('SELECT coalesce(max(update_id), 0) AS id FROM processed_updates')
    .id
}

/** The first update the server received after `updateId`. */
function receivedAfter(updateId) {
  return get(
    'SELECT update_id, received_at FROM processed_updates WHERE update_id > ? ORDER BY update_id LIMIT 1',
    updateId,
  )
}

/** Message ids Chairside has sent in one chat (replies, offers, confirmations). */
function sentInChat(chatId) {
  return all(
    `SELECT a.telegram_message_id AS id FROM actions a JOIN requests q ON q.id = a.request_id
       WHERE q.chat_id = ? AND a.telegram_message_id IS NOT NULL
     UNION SELECT offer_message_id FROM offers WHERE chat_id = ? AND offer_message_id IS NOT NULL`,
    chatId,
    chatId,
  ).length
}

function describeRequest(row) {
  const slot = row.requested_start_utc ? local(row.requested_start_utc) : 'no time'
  return `${row.intent}, ${row.service_id ?? 'no service'}, ${slot}`
}

// ---- the simulator --------------------------------------------------------

/** Polls the console; stamps every entry with when the runner first saw it. */
async function poll() {
  await sim.pollConsole()
  const now = Date.now()
  for (const entry of sim.entries) entry.seenAt ??= now
}

const cursor = () => sim.entries.length

/** Waits for an app console line at or after index `from`; returns { entry, match, at }. */
function waitLine(what, pattern, from, timeoutMs, accept = () => true) {
  return waitFor(
    `"${what}" in the simulator console`,
    timeoutMs,
    async () => {
      await poll()
      for (const entry of sim.entries.slice(from)) {
        const match = pattern.exec(entry.message)
        if (match && accept(match)) return { entry, match, at: entryTime(entry) }
      }
      return undefined
    },
    100,
  )
}

function cardKeys() {
  const keys = new Set()
  for (const entry of sim.entries) {
    const match = /card shown req=(\S+) v=(\d+)/.exec(entry.message)
    if (match) keys.add(`${match[1]}:${match[2]}`)
  }
  return keys
}

/** A settled glasses screenshot saved as evidence; failures are noted, not fatal. */
async function shot(name, caption, { changed = true } = {}) {
  try {
    const frame = await settledFrame(sim, changed ? lastFrame : undefined, 4000)
    lastFrame = frame
    const file = `live-smoke-${String(r.shots.length + 1).padStart(2, '0')}-${name}.png`
    writeFileSync(join(evidenceDir, file), frame.png)
    r.shots.push({ path: `docs/evidence/${file}`, caption })
  } catch (error) {
    r.shots.push({
      path: '(none)',
      caption: `${caption}: screenshot failed (${error.message})`,
    })
  }
}

async function backToRoot(from) {
  await waitLine('screen=root', /\[chairside\] screen=root/, from, 15_000)
}

// ---- steps ------------------------------------------------------------------

function preflight() {
  // Loads apps/server/.env without overriding variables set in the shell.
  ;({ calendar, shop } = demoContext())
  if (process.env.DEV_INJECT === '1') {
    throw new Error(
      'DEV_INJECT=1 is TEST MODE; the live smoke needs real services. Unset it.',
    )
  }
  const missing = [
    'TELEGRAM_BOT_TOKEN',
    'OWNER_TELEGRAM_USER_ID',
    'DEVICE_TOKEN_PEPPER',
  ].filter((name) => !process.env[name])
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in apps/server/.env`)
  }
  const day = options.day ?? defaultDay(Date.now(), shop.timezone)
  const date = DateTime.fromISO(day, { zone: shop.timezone })
  const today = DateTime.now().setZone(shop.timezone).startOf('day')
  if (date <= today) {
    throw new Error(
      `--day ${day} must be after today: today holds the seeded demo events`,
    )
  }
  const hours = shop.hours[String(date.weekday)]
  if (!hours || hours.open > '11:00' || hours.close < '18:30') {
    throw new Error(
      `${shop.name} must be open 11:00-18:30 on ${day}; pick another --day`,
    )
  }
  r.env = {
    node: process.version,
    platform: process.platform,
    telegramMode: process.env.TELEGRAM_MODE ?? 'business',
    shopConfig: process.env.SHOP_CONFIG_PATH ?? '../../config/shop.demo.json',
    timezone: shop.timezone,
    day,
    spokenDay: spokenDay(day),
  }
  lines = customerLines(day)
}

async function botUsername() {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`,
      { signal: AbortSignal.timeout(5000) },
    )
    const json = await response.json()
    return json.ok ? json.result.username : undefined
  } catch {
    return undefined
  }
}

async function cleanStart() {
  const removed = await resetDemo(calendar, shop, DateTime.now())
  const { day } = r.env
  const from = Date.parse(localUtc(day, '14:00'))
  const to = Date.parse(localUtc(day, '18:30'))
  const clash = (await dayEvents(day)).filter(
    (event) => Date.parse(event.startUtc) < to && Date.parse(event.endUtc) > from,
  )
  if (clash.length) {
    throw new Error(
      `${r.env.spokenDay} already has ${clash.length} event(s) between 14:00 and 18:30 (bookings from an earlier run?). Delete them in Google Calendar or pass --day with another free day.`,
    )
  }
  const seeded = await seedDemoEvents(
    calendar,
    shop,
    DateTime.now(),
    String(Date.now()),
  )
  r.clean = {
    removed: removed.length,
    seeded: seeded.map(({ event }) => ({
      id: event.id,
      local: formatLocal(event, shop.timezone),
      summary: event.summary,
    })),
  }
  mark(
    `clean start: removed ${removed.length} demo event(s), seeded ${seeded.length}`,
  )
}

async function startServer() {
  const startedAt = Date.now()
  server = start(
    'server',
    process.execPath,
    ['--import', 'tsx', 'src/index.ts'],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(ports.backend) },
      windowsHide: true,
    },
  )
  await waitFor('the server /healthz', 30_000, () =>
    httpOk(`${serverBase}/healthz`),
  )
  return Date.now() - startedAt
}

async function pairFromScratch(simulator, username) {
  await startVite(username ? { VITE_BOT_USERNAME: username } : {})
  mark('launching the simulator (fresh storage, so pairing starts from scratch)')
  const launchedAt = Date.now()
  const launched = await launchSimulator(simulator, appUrl)
  sim = launched.sim
  await poll()
  r.pairing = { readyS: Math.round(launched.readyMs / 10) / 100 }
  const issued = await waitLine(
    'pair code issued',
    /\[chairside\] pair code issued/,
    0,
    30_000,
  )
  r.pairing.launchToCodeS = secondsBetween(launchedAt, issued.at)
  const row = get(
    'SELECT code FROM pair_codes WHERE shop_id IS NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY rowid DESC LIMIT 1',
    new Date().toISOString(),
  )
  if (!row) throw new Error('no live pairing code in the server database')
  await shot('pairing', 'the pairing screen (single-use code, long expired)', {
    changed: false,
  })
  ask(
    `OWNER: from the owner's Telegram account, send this to @${username ?? 'the bot'}:   /pair ${row.code}`,
  )
  mark('waiting for the owner to pair')
  const paired = await waitLine('paired', /\[chairside\] paired\b/, 0, waitMs)
  const pairedAt = sim.entries.indexOf(paired.entry)
  r.pairing.codeToPairedS = secondsBetween(issued.at, paired.at)
  const live = await waitLine('link=live', /\[chairside\] link=live/, pairedAt, 30_000)
  r.pairing.pairedToLiveS = secondsBetween(paired.at, live.at)
  check(true, 'paired from scratch with a code sent in Telegram')
  await backToRoot(pairedAt)
  await shot('root-paired', 'paired: the root screen')
  mark('paired')
}

/** Prints what a customer should send and waits for the new card it opens. */
async function customerCard(label, who, text) {
  const from = cursor()
  const known = cardKeys()
  const updates = maxUpdateId()
  ask(`${who}: send this to the owner's Telegram account:   ${text}`)
  mark(`waiting for the ${label} DM`)
  const shown = await waitLine(
    `${label} card`,
    /\[chairside\] card shown req=(\S+) v=(\d+)/,
    from,
    waitMs,
    (match) => !known.has(`${match[1]}:${match[2]}`),
  )
  const requestId = shown.match[1]
  const request = get('SELECT * FROM requests WHERE id = ?', requestId)
  const received = receivedAfter(updates)
  mark(`${label} card shown (request ${requestId})`)
  return {
    requestId,
    version: Number(shown.match[2]),
    request,
    messageIds: all(
      'SELECT message_id FROM request_messages WHERE request_id = ? ORDER BY message_id',
      requestId,
    ).map((row) => row.message_id),
    telegramToCardS: secondsBetween(
      Date.parse(request.last_customer_msg_at),
      shown.at,
    ),
    receivedToCardS: received
      ? secondsBetween(Date.parse(received.received_at), shown.at)
      : undefined,
  }
}

/** Holds the card for --pause seconds, taps, and waits for the app's action result. */
async function tap(requestId) {
  await delay(options.pauseS * 1000)
  const from = cursor()
  const tappedAt = Date.now()
  await sim.input('click')
  mark(`tap (request ${requestId})`)
  const result = await waitLine(
    'action result',
    new RegExp(`\\[chairside\\] action result req=${requestId} status=(\\w+)`),
    from,
    30_000,
  )
  const action = get(
    'SELECT * FROM actions WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    requestId,
  )
  return { from, tappedAt, status: result.match[1], resultAt: result.at, action }
}

async function moment1() {
  const { day } = r.env
  const card = await customerCard('Moment 1', 'ANNA (customer account 1)', lines.anna)
  const m = (r.moment1 = {
    requestId: card.requestId,
    dmMessageIds: card.messageIds,
    parsed: describeRequest(card.request),
    telegramToCardS: card.telegramToCardS,
    receivedToCardS: card.receivedToCardS,
  })
  check(
    card.request.service_id === 'skin_fade' &&
      sameInstant(card.request.requested_start_utc, localUtc(day, '15:00')),
    `Moment 1 parsed a skin fade at 15:00 (got ${m.parsed})`,
  )
  await shot('m1-card', 'Moment 1: the card, smart default highlighted', {
    changed: false,
  })
  const t = await tap(card.requestId)
  m.status = t.status
  m.actionId = t.action?.id
  m.tapToServerS = secondsBetween(t.tappedAt, Date.parse(t.action?.created_at))
  m.tapToReceiptS = secondsBetween(t.tappedAt, t.resultAt)
  check(t.status === 'ok', `Moment 1 tap answered ok (got ${t.status})`)
  await shot('m1-receipt', 'Moment 1: the receipt after one tap')
  m.replyMessageId = t.action.telegram_message_id ?? undefined
  check(
    Boolean(m.replyMessageId),
    'Moment 1 reply sent: Telegram returned a message id',
  )
  m.tapToReplyS = secondsBetween(t.tappedAt, Date.parse(t.action.updated_at))
  const booking = get('SELECT * FROM bookings WHERE id = ?', t.action.id)
  check(Boolean(booking), 'Moment 1 booking recorded')
  m.eventId = booking.calendar_event_id
  m.eventLocal = interval(booking.slot_start_utc, booking.slot_end_utc)
  check(
    sameInstant(booking.slot_start_utc, localUtc(day, '15:00')),
    `Moment 1 booked 15:00 (got ${m.eventLocal})`,
  )
  m.eventVerified = await verifyEvent(
    booking.calendar_event_id,
    booking.slot_start_utc,
    booking.slot_end_utc,
  )
  check(m.eventVerified, 'Moment 1 event read back from Google Calendar')
  await backToRoot(t.from)
  mark('Moment 1 done')
}

async function moment2() {
  const card = await customerCard(
    'Moment 2',
    'OMAR (customer account 2; account 1 works too)',
    lines.omar,
  )
  const m = (r.moment2 = {
    requestId: card.requestId,
    dmMessageIds: card.messageIds,
    telegramToCardS: card.telegramToCardS,
  })
  await shot('m2-card', 'Moment 2: 15:00 is taken; the card offers the next opening', {
    changed: false,
  })
  const t = await tap(card.requestId)
  check(t.status === 'ok', `Moment 2 offer tap answered ok (got ${t.status})`)
  const offer = get(
    'SELECT * FROM offers WHERE request_id = ? ORDER BY rowid DESC LIMIT 1',
    card.requestId,
  )
  check(
    Boolean(offer?.offer_message_id),
    'Moment 2 offer sent: Telegram returned a message id',
  )
  m.offerLocal = interval(offer.slot_start_utc, offer.slot_end_utc)
  m.offerMessageId = offer.offer_message_id
  m.offerStatusAfterTap = offer.status
  await shot('m2-offer-sent', 'Moment 2: the offer went out')
  await backToRoot(t.from)

  const from = cursor()
  const updates = maxUpdateId()
  ask('OMAR: reply in the same chat:   yes   (or press the Book button under the offer)')
  mark('waiting for the "yes"')
  const accepted = await waitFor(
    'the offer to be accepted and booked',
    waitMs,
    () => {
      const action = get(
        'SELECT * FROM actions WHERE idempotency_key = ?',
        `offer:${offer.id}`,
      )
      return action &&
        !['received', 'calendar_pending', 'send_started'].includes(action.state)
        ? action
        : undefined
    },
    250,
  )
  mark('offer accepted')
  const received = receivedAfter(updates)
  m.yesToBookedS = received
    ? secondsBetween(Date.parse(received.received_at), Date.parse(accepted.updated_at))
    : undefined
  check(accepted.state === 'ok', `Moment 2 "yes" booked it (state ${accepted.state})`)
  m.bookingMessageId = accepted.telegram_message_id ?? undefined
  check(
    Boolean(m.bookingMessageId),
    'Moment 2 confirmation sent: Telegram returned a message id',
  )
  const booking = get('SELECT * FROM bookings WHERE id = ?', accepted.id)
  check(Boolean(booking), 'Moment 2 booking recorded')
  m.eventId = booking.calendar_event_id
  m.eventLocal = interval(booking.slot_start_utc, booking.slot_end_utc)
  check(
    sameInstant(booking.slot_start_utc, offer.slot_start_utc),
    `Moment 2 booked the offered time (got ${m.eventLocal})`,
  )
  m.eventVerified = await verifyEvent(
    booking.calendar_event_id,
    booking.slot_start_utc,
    booking.slot_end_utc,
  )
  check(m.eventVerified, 'Moment 2 event read back from Google Calendar')
  m.offerStatus = get('SELECT status FROM offers WHERE id = ?', offer.id).status
  check(m.offerStatus === 'accepted', `Moment 2 offer marked accepted (got ${m.offerStatus})`)
  try {
    await waitLine('screen=receipt', /\[chairside\] screen=receipt/, from, 15_000)
    note(true, 'Moment 2 the glasses showed the booking as an update')
    await shot('m2-booked', 'Moment 2: the "yes" booked it; the glasses show the update')
    await backToRoot(from)
  } catch {
    note(false, 'Moment 2 the glasses showed the booking as an update')
  }
  mark('Moment 2 done')
}

async function moment3() {
  const { day } = r.env
  const card = await customerCard('Moment 3', 'ANNA (customer account 1)', lines.beard)
  const m = (r.moment3 = { requestId: card.requestId })
  check(
    card.request.service_id === 'beard_trim' &&
      sameInstant(card.request.requested_start_utc, localUtc(day, '17:00')),
    `Moment 3 parsed a beard trim at 17:00 (got ${describeRequest(card.request)})`,
  )
  m.slotLocal = local(card.request.requested_start_utc)
  await shot('m3-card', 'Moment 3: the card shows 17:00 free', { changed: false })
  const block = await blockSlot(calendar, shop, `${day} 17:00`, 30, String(Date.now()))
  m.blockId = block.id
  m.blockLocal = formatLocal(block, shop.timezone)
  mark(`foreign block inserted at ${m.blockLocal}`)
  const chatId = card.request.chat_id
  m.before = {
    sent: sentInChat(chatId),
    events: (await dayEvents(day, block.id)).length,
  }
  const t = await tap(card.requestId)
  m.status = t.status
  check(t.status === 'slot_taken', `Moment 3 tap answered slot_taken (got ${t.status})`)
  const again = await waitLine(
    'the card again',
    new RegExp(`\\[chairside\\] card shown req=${card.requestId} v=(\\d+)`),
    t.from,
    15_000,
    (match) => Number(match[1]) > card.version,
  )
  m.versionAfter = Number(again.match[1])
  await shot(
    'm3-slot-taken',
    'Moment 3: nothing sent; the card says the slot was just taken and offers the next opening',
  )
  m.after = {
    sent: sentInChat(chatId),
    events: (await dayEvents(day, block.id)).length,
  }
  check(
    m.after.sent === m.before.sent,
    `Moment 3 sent no message (before ${m.before.sent}, after ${m.after.sent})`,
  )
  check(
    m.after.events === m.before.events,
    `Moment 3 wrote no event (before ${m.before.events}, after ${m.after.events})`,
  )
  check(
    !t.action.telegram_message_id &&
      !get('SELECT 1 AS hit FROM bookings WHERE request_id = ?', card.requestId),
    'Moment 3 has no reply id and no booking row',
  )
  // Leave the card waiting and go back to root (a double tap on a card).
  const from = cursor()
  await sim.input('double_click')
  await backToRoot(from)
  mark('Moment 3 done')
}

async function reconnect() {
  const from = cursor()
  const stoppedAt = Date.now()
  await stop(server)
  server = undefined
  const rc = (r.reconnect = { stoppedAt: iso(stoppedAt) })
  mark('server stopped')
  const down = await waitLine(
    'screen=status',
    /\[chairside\] screen=status/,
    from,
    30_000,
  )
  rc.statusS = secondsBetween(stoppedAt, down.at)
  await shot('reconnect-status', 'server stopped: the status screen')
  const restartFrom = cursor()
  const restartedAt = Date.now()
  rc.restartedAt = iso(restartedAt)
  rc.listeningS = Math.round((await startServer()) / 10) / 100
  mark('server restarted')
  const back = await waitLine(
    'screen=root after the restart',
    /\[chairside\] screen=root/,
    restartFrom,
    60_000,
  )
  rc.backS = secondsBetween(restartedAt, back.at)
  const after = sim.entries.slice(from).map((entry) => entry.message)
  rc.links = after
    .filter((message) => /\] link=/.test(message))
    .map((message) => message.replace('[chairside] ', ''))
  rc.noRepair = !after.some((message) =>
    /screen=pair|paired|pair code issued|device token rejected/.test(message),
  )
  check(rc.noRepair, 'the restart did not ask to pair again')
  await shot('reconnect-root', 'server back: root again, no pairing')
  if (options.finalDm) {
    await customerCard('post-restart', 'ANNA (customer account 1)', lines.final)
    rc.finalCard = true
    check(true, 'a DM after the restart opened a card')
    await shot('reconnect-card', 'a DM after the restart still opens a card', {
      changed: false,
    })
  }
  mark('reconnect done')
}

async function cleanup() {
  if (options.keepDemo) {
    r.cleanup = 'skipped (--keep-demo)'
    return
  }
  const removed = await resetDemo(calendar, shop, DateTime.now())
  const blockId = r.moment3?.blockId
  if (blockId && !removed.some((event) => event.id === blockId)) {
    await calendar.deleteEvent(blockId).catch(() => {})
  }
  r.cleanup = `removed ${removed.length} demo event(s) (the seeded bookings and the Moment 3 block); the Moment 1 and 2 bookings stay`
}

function writeEvidence() {
  r.finishedAt = new Date().toISOString()
  writeFileSync(join(evidenceDir, 'live-smoke.md'), renderReport(r))
  writeFileSync(
    join(evidenceDir, 'live-smoke.json'),
    `${JSON.stringify(r, null, 2)}\n`,
  )
  say('wrote docs/evidence/live-smoke.md and live-smoke.json')
}

async function finish(error) {
  if (finishing) return
  finishing = true
  if (error) {
    r.ok = false
    r.error = String(error.message ?? error).split('\n')[0]
    say(`FAIL: ${error.message ?? error}`)
  }
  if (started && calendar) {
    try {
      await cleanup()
    } catch (cleanupError) {
      r.cleanup = `failed: ${cleanupError.message}`
    }
  }
  await stopAll()
  db?.close()
  if (started) writeEvidence()
  say(r.ok ? 'PASS' : 'FAIL')
}

process.on('SIGINT', () => {
  finish(new Error('interrupted (Ctrl+C)')).finally(() => process.exit(130))
})

try {
  preflight()
  await assertPortsFree(['backend', 'vite', 'automation'])
  const simulator = findSimulator()
  say(
    `booking day ${r.env.day} (${r.env.spokenDay}), shop ${shop.name} in ${shop.timezone}`,
  )
  say('the people will be asked to send, in order:')
  say(`  owner:  /pair CODE (the code appears on the glasses)`)
  say(`  Anna:   ${lines.anna}`)
  say(`  Omar:   ${lines.omar}`)
  say(`  Omar:   ${lines.yes}`)
  say(`  Anna:   ${lines.beard}`)
  if (options.finalDm) say(`  Anna:   ${lines.final}`)
  started = true
  mkdirSync(evidenceDir, { recursive: true })
  for (const file of readdirSync(evidenceDir)) {
    if (/^live-smoke-\d+-.+\.png$/.test(file)) rmSync(join(evidenceDir, file))
  }
  await cleanStart()
  const username = await botUsername()
  const listeningMs = await startServer()
  mark(`server listening after ${(listeningMs / 1000).toFixed(1)} s`)
  db = new DatabaseSync(
    resolve(serverDir, process.env.DATABASE_PATH || 'data/chairside.db'),
    { readOnly: true },
  )
  await pairFromScratch(simulator, username)
  await moment1()
  await moment2()
  await moment3()
  await reconnect()
  r.ok = r.checks.every((c) => c.ok)
  await finish()
} catch (error) {
  await finish(error)
}
process.exit(r.ok ? 0 : 1)
