// npm run smoke:live: the live end-to-end smoke (US-015) with real Telegram and
// real Google Calendar. It starts the server (real adapters, apps/server/.env),
// Vite and the Even Hub simulator, then walks the people through a pairing from
// scratch, the three demo moments and a reconnect. The runner taps the glasses
// and inserts the Moment 3 block itself; the people only send the Telegram
// messages it prints (lines starting "[smoke] >>>"). Before every tap it checks
// that the card is the expected request and that the highlighted action is the
// expected one, so it never acts on someone else's message.
//
// Evidence: a passing run replaces docs/evidence/live-smoke.md, live-smoke.json
// and live-smoke-*.png. A failed run leaves them alone and writes its report to
// docs/evidence/live-smoke-run/ (git-ignored). It records ids, times, counts and
// statuses only: never message text, names, or Telegram user and chat ids, and
// it takes screenshots only of customer accounts named Alex or James.
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
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { DateTime } from 'luxon'
import {
  blockSlot,
  formatLocal,
  isDemoEvent,
  resetDemo,
  seedDemoEvents,
} from '../apps/server/src/demo/index.ts'
import { CODE_TTL_MS } from '../apps/server/src/devices/pairing.ts'
import {
  appUrl,
  assertPortsFree,
  httpOk,
  launchSimulator,
  packageBin,
  ports,
  root,
  settledFrame,
  startVite,
} from '../e2e/lib/harness.mjs'
import { compare } from '../e2e/lib/frames.mjs'
import { run, start, stop, stopAll, waitFor } from '../e2e/lib/processes.mjs'
import { findSimulator } from '../e2e/lib/simulator.mjs'
import { demoContext } from './lib/demo-env.ts'
import {
  customerLines,
  defaultDay,
  entryTime,
  parseArgs,
  redact,
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
const runDir = join(evidenceDir, 'live-smoke-run')
const serverDir = join(root, 'apps', 'server')
const serverBase = `http://127.0.0.1:${ports.backend}`
const waitMs = options.waitMin * 60_000
// Screenshots go into a public repository: only these customer names may appear.
const PERSONAS = new Set(['alex', 'james'])

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
let interrupted = false
let finishing
// Requests this run asked for; any other card on the glasses keeps the evidence private.
const ownRequests = new Set()
// The test customers' Telegram user ids (SMOKE_CUSTOMER_IDS): the only chats
// whose cards the runner acts on. Held in memory, never printed or recorded.
let customerChats = new Set()
// Each role's chat, fixed by its first message (in memory only).
const roleChats = {}
// Calendar events this run created, as created: cleanup deletes only these,
// and only while unchanged.
const created = []

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

const overlaps = (a, b) =>
  Date.parse(a.startUtc) < Date.parse(b.endUtc) &&
  Date.parse(a.endUtc) > Date.parse(b.startUtc)

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

function maxMessageRow() {
  return get('SELECT coalesce(max(rowid), 0) AS id FROM request_messages').id
}

/**
 * The last update the server received after `updateId` and no later than
 * `beforeIso`: the message that completed a request (or an acceptance).
 * Updates carry no chat, so another chat's message could be picked instead.
 */
function receivedBefore(updateId, beforeIso) {
  return get(
    `SELECT update_id, received_at FROM processed_updates
       WHERE update_id > ? AND received_at <= ?
       ORDER BY received_at DESC, update_id DESC LIMIT 1`,
    updateId,
    beforeIso,
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

/** The card's first action, the one a tap selects: cards list proposals in rowid order. */
function firstAction(requestId, version) {
  return get(
    'SELECT id, kind, slot_start_utc FROM proposals WHERE request_id = ? AND version = ? ORDER BY rowid LIMIT 1',
    requestId,
    version,
  )
}

function describeAction(action) {
  if (!action) return 'none'
  return action.slot_start_utc
    ? `${action.kind} ${local(action.slot_start_utc)}`
    : action.kind
}

function describeRequest(row) {
  const slot = row.requested_start_utc ? local(row.requested_start_utc) : 'no time'
  return `${row.intent}, ${row.service_id ?? 'no service'}, ${slot}`
}

/**
 * Checked in memory only; the name itself is never printed or recorded. The
 * whole first name must match the role (cards show all of it).
 */
function personaNamed(row, role) {
  const name = String(row.customer_first_name ?? '')
    .trim()
    .toLowerCase()
  return PERSONAS.has(name) && name === role
}

/** Stops a step once finishing has begun (Ctrl+C or an error elsewhere). */
function stopIfFinishing() {
  if (finishing) throw new Error('stopping: the run is finishing')
}

// ---- the simulator --------------------------------------------------------

/** Polls the console; stamps every entry with when the runner first saw it. */
async function poll() {
  await sim.pollConsole()
  const now = Date.now()
  for (const entry of sim.entries) entry.seenAt ??= now
}

const cursor = () => sim.entries.length

// Console lines that mean the glasses' display or selection changed.
const SCREEN_CHANGE =
  /\[chairside\] (?:screen=|card shown |receipt title=|gesture=)/

function lastIndexOf(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i
  return -1
}

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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Waits for a drawn receipt with this one-word title (Done, Update) at or
 * after `from`; with `key`, only the receipt for that action.
 */
function waitReceipt(title, from, timeoutMs = 15_000, key) {
  const suffix = key ? ` key=${escapeRegExp(key)}` : '(?: key=\\S+)?'
  return waitLine(
    `receipt title=${title}${key ? ` key=${key}` : ''}`,
    new RegExp(`\\[chairside\\] receipt title=${title}${suffix}$`),
    from,
    timeoutMs,
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

/**
 * A settled glasses screenshot for the evidence. A failed optional one is
 * noted; a failed required one (named in US-015) fails the run.
 */
async function shot(
  name,
  caption,
  { changed = true, required = false, since } = {},
) {
  const file = `${String(r.shots.length + 1).padStart(2, '0')}-${name}.png`
  try {
    const frame = await settledFrame(sim, changed ? lastFrame : undefined, 4000)
    // A required picture of a new state must differ from the previous one;
    // settledFrame gives up waiting for a change after its deadline.
    if (required && changed && lastFrame && compare(lastFrame, frame).changed === 0) {
      throw new Error('the display never changed to the expected state')
    }
    // `since` is the console entry of the state this picture is for (drawn
    // before the capture began). If the display moved on before the capture
    // finished, or a later change cannot be placed in time (no simulator
    // timestamp), the picture may show something else.
    if (since !== undefined) {
      const capturedAt = Date.now()
      await poll()
      const moved = sim.entries
        .slice(since + 1)
        .some(
          (entry) =>
            SCREEN_CHANGE.test(entry.message) &&
            (typeof entry.ts !== 'number' || entryTime(entry) <= capturedAt),
        )
      if (moved) throw new Error('the display changed before the capture finished')
    }
    lastFrame = frame
    writeFileSync(join(runDir, file), frame.png)
    r.shots.push({ file, path: `docs/evidence/live-smoke-run/${file}`, caption })
  } catch (error) {
    r.shots.push({
      path: '(none)',
      caption: `${caption}: screenshot failed (${redact(error.message)})`,
    })
    if (required) check(false, `screenshot ${name} saved`)
  }
}

async function backToRoot(from) {
  await waitLine('screen=root', /\[chairside\] screen=root/, from, 15_000)
}

/**
 * Asks the operator for a count they read off the screen; the Bot API cannot
 * read a chat's history. Times out after --wait minutes.
 */
async function operatorCount(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // On a terminal, readline takes Ctrl+C: pass it on to the runner.
  rl.on('SIGINT', () => process.emit('SIGINT'))
  try {
    const answer = await rl.question(`\n[smoke] ??? ${question} `, {
      signal: AbortSignal.timeout(waitMs),
    })
    // Digits only: a bare Enter must not count as zero. The answer itself is
    // never echoed into errors (it is free text).
    const text = String(answer).trim()
    const count = Number(text)
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(count)) {
      throw new Error('the operator answer was not a whole number')
    }
    return count
  } finally {
    rl.close()
  }
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
  if ((process.env.TELEGRAM_MODE ?? 'business') !== 'business') {
    throw new Error(
      'The live smoke follows the Telegram Business story: set TELEGRAM_MODE=business',
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
  customerChats = new Set(
    String(process.env.SMOKE_CUSTOMER_IDS ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )
  if (customerChats.size < 2) {
    throw new Error(
      'Set SMOKE_CUSTOMER_IDS in apps/server/.env to the Telegram user ids of the two test customer accounts (Alex and James), comma-separated (message @userinfobot from each). The runner acts only on cards from those chats.',
    )
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
    telegramMode: 'business',
    shopConfig: basename(process.env.SHOP_CONFIG_PATH ?? 'shop.demo.json'),
    timezone: shop.timezone,
    day,
    spokenDay: spokenDay(day),
    pauseS: options.pauseS,
  }
  lines = customerLines(day)
}

/** Read-only, before anything is touched: the demo window must hold no real events. */
async function checkDayFree() {
  const { day } = r.env
  const window = {
    startUtc: localUtc(day, '14:00'),
    endUtc: localUtc(day, '18:30'),
  }
  const clash = (await dayEvents(day)).filter(
    (event) => !isDemoEvent(event) && overlaps(event, window),
  )
  if (clash.length) {
    throw new Error(
      `${r.env.spokenDay} already has ${clash.length} event(s) between 14:00 and 18:30 (bookings from an earlier run?). Delete them in Google Calendar or pass --day with another free day.`,
    )
  }
  // The glasses' root screen names today's next bookings, and its
  // screenshots are public: today may hold demo events only.
  const today = DateTime.now().setZone(shop.timezone)
  const real = (await dayEvents(today.toISODate())).filter(
    (event) => !isDemoEvent(event) && Date.parse(event.endUtc) > Date.now(),
  )
  if (real.length) {
    throw new Error(
      `Today's shop calendar has ${real.length} upcoming non-demo event(s); the glasses' home screen would show them in public screenshots. Use a calendar with only demo events today.`,
    )
  }
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

async function resetAndSeed() {
  const removed = await resetDemo(calendar, shop, DateTime.now())
  let seeded
  try {
    seeded = await seedDemoEvents(calendar, shop, DateTime.now(), String(Date.now()))
  } catch (error) {
    // A seed that failed half-way returns nothing to track, so clear every
    // demo-marked event again (what demo:reset does) before failing.
    await resetDemo(calendar, shop, DateTime.now()).catch(() => {})
    throw error
  }
  for (const { event } of seeded) {
    created.push({
      id: event.id,
      startUtc: event.startUtc,
      endUtc: event.endUtc,
      summary: event.summary,
    })
  }
  r.clean = {
    removed: removed.length,
    seeded: seeded.map(({ event }) => ({
      id: event.id,
      local: formatLocal(event, shop.timezone),
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
  mark('launching the simulator with fresh storage (pairing from scratch)')
  const launchedAt = Date.now()
  const launched = await launchSimulator(simulator, `${appUrl}/?fresh=1`)
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
  await shot('pairing', 'the pairing screen (single-use code, long expired)', {
    changed: false,
  })
  // The owner reads the code off the glasses: a code looked up in the
  // database could belong to another device that asked at the same moment.
  ask(
    `OWNER: from the owner's Telegram account, send @${username ?? 'the bot'} the line shown on the glasses:   /pair <6-character code>`,
  )
  mark('waiting for the owner to pair')
  const expiresAt = issued.at + CODE_TTL_MS
  let paired
  try {
    paired = await waitLine(
      'paired',
      /\[chairside\] paired\b/,
      0,
      Math.max(1000, Math.min(waitMs, expiresAt - Date.now() + 5000)),
    )
  } catch (error) {
    if (Date.now() >= expiresAt) {
      throw new Error('the pairing code expired before the owner sent it; run again')
    }
    throw error
  }
  const pairedAt = sim.entries.indexOf(paired.entry)
  r.pairing.codeToPairedS = secondsBetween(issued.at, paired.at)
  const live = await waitLine('link=live', /\[chairside\] link=live/, pairedAt, 30_000)
  r.pairing.pairedToLiveS = secondsBetween(paired.at, live.at)
  check(true, 'paired from scratch with a code sent in Telegram')
  await backToRoot(pairedAt)
  await shot('root-paired', 'paired: the root screen')
  mark('paired')
}

/**
 * Prints what a customer should send and waits for the new card it opens.
 * `role` is the customer this step belongs to ('alex' or 'james'): the
 * card must carry that exact first name, and each role keeps one chat (the
 * two roles never share one). Chat ids stay in memory only.
 */
async function customerCard(label, who, text, role) {
  const from = cursor()
  const known = cardKeys()
  const updates = maxUpdateId()
  const messageRow = maxMessageRow()
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
  check(Boolean(request), `${label}: the server holds the request behind the card`)
  const chat = Number(request.chat_id)
  check(
    customerChats.has(chat),
    `${label}: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)`,
  )
  const Role = role[0].toUpperCase() + role.slice(1)
  check(
    personaNamed(request, role),
    `${label}: the card is from ${Role} (exact Telegram first name; the screenshots are public evidence)`,
  )
  if (roleChats[role] === undefined) {
    check(
      !Object.values(roleChats).includes(chat),
      `${label}: ${Role} writes from a different account than the other customer`,
    )
    roleChats[role] = chat
  } else {
    check(roleChats[role] === chat, `${label}: ${Role} writes from the same chat as before`)
  }
  ownRequests.add(requestId)
  const received = receivedBefore(updates, request.updated_at)
  // Only this run's messages: a request still pending from an earlier run
  // keeps its old ids, and an edited old message adds none.
  const messageIds = all(
    'SELECT message_id FROM request_messages WHERE request_id = ? AND rowid > ? ORDER BY message_id',
    requestId,
    messageRow,
  ).map((row) => row.message_id)
  check(messageIds.length > 0, `${label}: the card carries a new message from this run`)
  mark(`${label} card shown (request ${requestId})`)
  return {
    requestId,
    version: Number(shown.match[2]),
    request,
    shownIndex: sim.entries.indexOf(shown.entry),
    messageIds,
    telegramToCardS: secondsBetween(
      Date.parse(request.last_customer_msg_at),
      shown.at,
    ),
    receivedToCardS: received
      ? secondsBetween(Date.parse(received.received_at), shown.at)
      : undefined,
  }
}

/**
 * Holds the card for --pause seconds, then, right before the click, checks
 * that the card has not changed and that its highlighted action is the
 * expected one; taps and waits for the app's action result. `wanted`
 * describes the expected action.
 */
async function tap(card, label, wanted, expected) {
  await delay(options.pauseS * 1000)
  const current = get(
    'SELECT version, status FROM requests WHERE id = ?',
    card.requestId,
  )
  check(
    current?.version === card.version && current?.status === 'pending',
    `${label}: the card did not change during the hold (version ${current?.version}, ${current?.status})`,
  )
  const first = firstAction(card.requestId, card.version)
  check(
    Boolean(first) && expected(first),
    `${label}: the highlighted action is ${wanted} (got ${describeAction(first)})`,
  )
  // A click acts on whatever the glasses show: it must still be this card
  // and version, with no gesture or screen change since it was drawn, so
  // its first action is still the selected one.
  await poll()
  const drawn = lastIndexOf(
    sim.entries,
    (entry) =>
      entry.message ===
      `[chairside] card shown req=${card.requestId} v=${card.version}`,
  )
  check(
    drawn >= 0 &&
      !sim.entries
        .slice(drawn + 1)
        .some((entry) => SCREEN_CHANGE.test(entry.message)),
    `${label}: the glasses still show this card with its first action selected`,
  )
  stopIfFinishing()
  const from = cursor()
  const tappedAt = Date.now()
  await sim.input('click')
  mark(`tap (request ${card.requestId})`)
  const result = await waitLine(
    'action result',
    new RegExp(`\\[chairside\\] action result req=${card.requestId} status=(\\w+)`),
    from,
    30_000,
  )
  // Unique per request, version and action: this tap's row, not a competing one.
  const action = get(
    'SELECT * FROM actions WHERE request_id = ? AND version = ? AND action_id = ?',
    card.requestId,
    card.version,
    first.id,
  )
  return { from, tappedAt, status: result.match[1], action }
}

async function moment1() {
  const { day } = r.env
  const card = await customerCard(
    'Moment 1',
    'ALEX (customer account 1)',
    lines.haircut,
    'alex',
  )
  const m = (r.moment1 = {
    requestId: card.requestId,
    dmMessageIds: card.messageIds,
    parsed: describeRequest(card.request),
    telegramToCardS: card.telegramToCardS,
    receivedToCardS: card.receivedToCardS,
  })
  check(
    card.request.service_id === 'haircut' &&
      sameInstant(card.request.requested_start_utc, localUtc(day, '15:00')),
    `Moment 1 parsed a haircut at 15:00 (got ${m.parsed})`,
  )
  await shot('m1-card', 'Moment 1: the card, smart default highlighted', {
    changed: false,
    required: true,
    since: card.shownIndex,
  })
  const t = await tap(
    card,
    'Moment 1',
    'Book & reply at 15:00',
    (first) =>
      first.kind === 'book' &&
      sameInstant(first.slot_start_utc, localUtc(day, '15:00')),
  )
  m.status = t.status
  m.actionId = t.action?.id
  m.tapToServerS = secondsBetween(t.tappedAt, Date.parse(t.action?.created_at))
  check(t.status === 'ok', `Moment 1 tap answered ok (got ${t.status})`)
  const receipt = await waitReceipt('Done', t.from)
  m.tapToReceiptS = secondsBetween(t.tappedAt, receipt.at)
  await shot('m1-receipt', 'Moment 1: the receipt after one tap', {
    required: true,
    since: sim.entries.indexOf(receipt.entry),
  })
  m.replyMessageId = t.action.telegram_message_id ?? undefined
  check(
    Boolean(m.replyMessageId),
    'Moment 1 reply sent: Telegram returned a message id',
  )
  m.tapToReplyS = secondsBetween(t.tappedAt, Date.parse(t.action.updated_at))
  // The whole glasses workflow, with the --pause hold standing in for the owner reading the card.
  m.dmToReplyS = secondsBetween(
    Date.parse(card.request.last_customer_msg_at),
    Date.parse(t.action.updated_at),
  )
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
  await backToRoot(sim.entries.indexOf(receipt.entry))
  mark('Moment 1 done')
}

async function moment2() {
  const { day } = r.env
  const card = await customerCard(
    'Moment 2',
    'JAMES (customer account 2)',
    lines.skinFade,
    'james',
  )
  const m = (r.moment2 = {
    requestId: card.requestId,
    dmMessageIds: card.messageIds,
    telegramToCardS: card.telegramToCardS,
  })
  check(
    card.request.service_id === 'skin_fade' &&
      sameInstant(card.request.requested_start_utc, localUtc(day, '15:00')),
    `Moment 2 parsed a skin fade at 15:00 (got ${describeRequest(card.request)})`,
  )
  await shot('m2-card', 'Moment 2: 15:00 is taken; the card offers the next opening', {
    changed: false,
    since: card.shownIndex,
  })
  // Taken before the tap, so even an instant "yes" is after this point.
  const updates = maxUpdateId()
  const messageRow = maxMessageRow()
  const t = await tap(
    card,
    'Moment 2',
    'an offer later that afternoon',
    (first) =>
      first.kind === 'offer' &&
      Date.parse(first.slot_start_utc) > Date.parse(localUtc(day, '15:00')) &&
      Date.parse(first.slot_start_utc) < Date.parse(localUtc(day, '18:30')),
  )
  check(t.status === 'ok', `Moment 2 offer tap answered ok (got ${t.status})`)
  const offerSent = await waitReceipt('Done', t.from)
  await shot('m2-offer-sent', 'Moment 2: the offer went out', {
    since: sim.entries.indexOf(offerSent.entry),
  })
  // The offer row shares its id with the tapped action (send.ts insertOffer).
  const offer = get('SELECT * FROM offers WHERE id = ?', t.action.id)
  check(
    Boolean(offer?.offer_message_id),
    'Moment 2 offer sent: Telegram returned a message id',
  )
  m.offerId = offer.id
  m.offerLocal = interval(offer.slot_start_utc, offer.slot_end_utc)
  m.offerMessageId = offer.offer_message_id
  m.offerStatusAfterTap = offer.status

  ask('JAMES: type yes in the same chat and send it (not the Book button)')
  mark('waiting for the "yes"')
  // Finished means a stored outcome: finish() writes result_json with the final state.
  const accepted = await waitFor(
    'the offer to be accepted and finished',
    waitMs,
    () => {
      const action = get(
        'SELECT * FROM actions WHERE idempotency_key = ?',
        `offer:${offer.id}`,
      )
      return action?.result_json ? action : undefined
    },
    250,
  )
  mark('offer accepted')
  // This acceptance's receipt stays up for 2 s: capture it before the slower checks.
  const update = await waitReceipt('Update', t.from, 15_000, `offer:${offer.id}`)
  await shot(
    'm2-booked',
    'Moment 2: the "yes" booked it; the glasses show the update',
    { required: true, since: sim.entries.indexOf(update.entry) },
  )
  // A typed "yes" is stored on the offer's request; a button press is not.
  m.yesMessageIds = all(
    'SELECT message_id FROM request_messages WHERE request_id = ? AND rowid > ? ORDER BY message_id',
    card.requestId,
    messageRow,
  ).map((row) => row.message_id)
  // The server never keeps the text, so this proves a typed reply accepted
  // the offer, not that it read exactly "yes".
  check(
    m.yesMessageIds.length > 0,
    'Moment 2 James typed a reply that accepted the offer (its message id is recorded)',
  )
  const outcome = JSON.parse(accepted.result_json)
  const received = receivedBefore(updates, accepted.created_at)
  m.yesToBookedS = received
    ? secondsBetween(Date.parse(received.received_at), Date.parse(accepted.updated_at))
    : undefined
  check(
    outcome.status === 'ok' && accepted.state === 'sent',
    `Moment 2 "yes" booked it and the confirmation went out (status ${outcome.status}, state ${accepted.state})`,
  )
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
  await backToRoot(sim.entries.indexOf(update.entry))
  mark('Moment 2 done')
}

async function moment3() {
  const { day } = r.env
  const card = await customerCard(
    'Moment 3',
    'ALEX (customer account 1)',
    lines.beardTrim,
    'alex',
  )
  const m = (r.moment3 = { requestId: card.requestId })
  check(
    card.request.service_id === 'beard_trim' &&
      sameInstant(card.request.requested_start_utc, localUtc(day, '17:00')),
    `Moment 3 parsed a beard trim at 17:00 (got ${describeRequest(card.request)})`,
  )
  m.slotLocal = local(card.request.requested_start_utc)
  await shot('m3-card', 'Moment 3: the card shows 17:00 free', {
    changed: false,
    required: true,
    since: card.shownIndex,
  })
  stopIfFinishing()
  const block = await blockSlot(calendar, shop, `${day} 17:00`, 30, String(Date.now()))
  created.push({
    id: block.id,
    startUtc: block.startUtc,
    endUtc: block.endUtc,
    summary: block.summary,
  })
  m.blockId = block.id
  m.blockStartUtc = block.startUtc
  m.blockEndUtc = block.endUtc
  m.blockLocal = formatLocal(block, shop.timezone)
  mark(`foreign block inserted at ${m.blockLocal}`)
  // Tap only once Google reports the block, so the server's recheck cannot miss it.
  await waitFor(
    'the block in Google free/busy and the event list',
    60_000,
    async () => {
      const busy = await calendar.freeBusy(block.startUtc, block.endUtc)
      if (!busy.ok || !busy.busy.some((b) => overlaps(b, block))) return false
      const events = await calendar.listEvents(block.startUtc, block.endUtc)
      return events.some((event) => event.id === block.id)
    },
    1000,
  )
  const chatId = card.request.chat_id
  const threadQuestion =
    "In ALEX's chat (customer view), how many messages are below his beard-trim question? Type the number, then Enter:"
  m.before = {
    thread: await operatorCount(threadQuestion),
    sent: sentInChat(chatId),
    events: (await dayEvents(day, block.id)).length,
  }
  const t = await tap(
    card,
    'Moment 3',
    'Book & reply at 17:00',
    (first) =>
      first.kind === 'book' &&
      sameInstant(first.slot_start_utc, localUtc(day, '17:00')),
  )
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
  const next = firstAction(card.requestId, m.versionAfter)
  m.nextLocal = next?.slot_start_utc ? local(next.slot_start_utc) : undefined
  // The picture claims a next opening: the card must really lead with one
  // (a failed availability lookup would leave only "Not now").
  check(
    next?.kind === 'offer' &&
      Date.parse(next.slot_start_utc) > Date.parse(localUtc(day, '17:00')) &&
      Date.parse(next.slot_start_utc) < Date.parse(localUtc(day, '20:00')),
    `Moment 3 the card now offers the next opening (got ${describeAction(next)})`,
  )
  await shot(
    'm3-slot-taken',
    'Moment 3: nothing sent; the card says the slot was just taken and offers the next opening',
    { required: true, since: sim.entries.indexOf(again.entry) },
  )
  m.after = {
    sent: sentInChat(chatId),
    events: (await dayEvents(day, block.id)).length,
    thread: await operatorCount(`Again: ${threadQuestion}`),
  }
  check(
    m.after.thread === m.before.thread,
    `Moment 3 Alex's thread did not change (operator count before ${m.before.thread}, after ${m.after.thread})`,
  )
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
  // Back means root drawn from a fresh snapshot of the restarted server: a
  // root drawn from the cache on reconnect, or a fresh draw that failed, is
  // not enough. The glasses log "root drawn seq=N" only after a draw succeeds.
  const fresh = await waitLine(
    'a fresh state from the restarted server',
    /\[chairside\] state seq=(\d+)/,
    restartFrom,
    60_000,
  )
  const freshSeq = Number(fresh.match[1])
  const drawn = await waitLine(
    'root drawn from the fresh state',
    /\[chairside\] root drawn seq=(\d+)/,
    sim.entries.indexOf(fresh.entry),
    15_000,
    (match) => Number(match[1]) >= freshSeq,
  )
  const back = { index: sim.entries.indexOf(drawn.entry) }
  rc.backS = secondsBetween(restartedAt, drawn.at)
  const after = sim.entries.slice(from).map((entry) => entry.message)
  rc.links = after
    .filter((message) => /\] link=/.test(message))
    .map((message) => message.replace('[chairside] ', ''))
  rc.noRepair = !after.some((message) =>
    /screen=pair|paired|pair code issued|device token rejected/.test(message),
  )
  check(rc.noRepair, 'the restart did not ask to pair again')
  await shot('reconnect-root', 'server back: root again, no pairing', {
    required: true,
    since: back.index,
  })
  if (options.finalDm) {
    await customerCard(
      'post-restart',
      'JAMES (customer account 2)',
      lines.final,
      'james',
    )
    rc.finalCard = true
    check(true, 'a DM after the restart opened a card')
    await shot('reconnect-card', 'a DM after the restart still opens a card', {
      changed: false,
    })
  }
  mark('reconnect done')
}

async function cleanup() {
  const pending = options.finalDm
    ? '; the last DM stays as a waiting card'
    : '; the Moment 3 request stays as a waiting card'
  if (options.keepDemo) {
    r.cleanup = `skipped (--keep-demo)${pending}`
    return
  }
  // Only what this run created, and only while it is unchanged: a demo event
  // someone edited (summary or time) may have become a real appointment.
  let removed = 0
  const kept = []
  for (const made of created) {
    const event = await calendar.getEvent(made.id)
    if (!event) continue
    if (
      isDemoEvent(event) &&
      event.summary === made.summary &&
      sameInstant(event.startUtc, made.startUtc) &&
      sameInstant(event.endUtc, made.endUtc)
    ) {
      await calendar.deleteEvent(made.id) // a failure fails the cleanup
      removed++
    } else {
      kept.push(made.id)
    }
  }
  r.cleanup = `removed this run's ${removed} demo event(s) (the seeded appointments and the Moment 3 block)${kept.length ? `; ${kept.length} changed after the run and stay` : ''}; the Moment 1 and 2 bookings stay${pending}`
}

/** Error text for the local diagnosis file: no child-process output, redacted. */
function diagnosis(error) {
  const text = String(error.stack ?? error)
    .split('\n')
    .filter((line) => !line.startsWith('  | '))
    .join('\n')
  return `${redact(text)}\n`
}

/** A failed run's report: only in the git-ignored run folder, never over the public evidence. */
function writeFailReport(error) {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'report.md'), renderReport(r))
  writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(r, null, 2)}\n`)
  if (error) writeFileSync(join(runDir, 'error.txt'), diagnosis(error))
  say(
    'FAIL report: docs/evidence/live-smoke-run/report.md (git-ignored); the last passing evidence is untouched',
  )
}

const PUBLIC_FILE = /^live-smoke(?:-\d+-.+\.png|\.md|\.json)$/

/**
 * A pass replaces the public evidence as one set. The report is staged in
 * the run folder, the previous set is backed up, and any error while
 * switching restores the previous set, so two runs never mix.
 */
function writePassEvidence() {
  for (const s of r.shots) {
    if (s.file) s.path = `docs/evidence/live-smoke-${s.file}`
  }
  writeFileSync(join(runDir, 'live-smoke.md'), renderReport(r))
  writeFileSync(join(runDir, 'live-smoke.json'), `${JSON.stringify(r, null, 2)}\n`)
  const backup = join(runDir, 'previous')
  mkdirSync(backup, { recursive: true })
  const previous = readdirSync(evidenceDir).filter((file) => PUBLIC_FILE.test(file))
  for (const file of previous) copyFileSync(join(evidenceDir, file), join(backup, file))
  const incoming = [
    ...r.shots.filter((s) => s.file).map((s) => [s.file, `live-smoke-${s.file}`]),
    ['live-smoke.md', 'live-smoke.md'],
    ['live-smoke.json', 'live-smoke.json'],
  ]
  // Undo exactly what happened: a locked file must not stop the restore.
  const removed = []
  const added = []
  try {
    for (const file of previous) {
      rmSync(join(evidenceDir, file), { force: true, maxRetries: 3 })
      removed.push(file)
    }
    for (const [from, to] of incoming) {
      renameSync(join(runDir, from), join(evidenceDir, to))
      added.push(to)
    }
  } catch (error) {
    for (const file of added) {
      try {
        rmSync(join(evidenceDir, file), { force: true, maxRetries: 3 })
      } catch {
        // Keep restoring the rest.
      }
    }
    for (const file of removed) {
      try {
        copyFileSync(join(backup, file), join(evidenceDir, file))
      } catch {
        // Keep restoring the rest.
      }
    }
    throw error
  }
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Leftover staging is harmless: the folder is git-ignored.
  }
  say('evidence: docs/evidence/live-smoke.md and live-smoke.json')
}

/**
 * On a pass, the public screenshots may show this run's customers only: no
 * other request's card, no receipt for another action, and (for the root
 * screen's next bookings) no real appointment on today's calendar.
 */
async function onlyOwnScreens() {
  const foreignCards = new Set()
  const foreignReceipts = new Set()
  const allowedUpdates = new Set(
    r.moment2?.offerId ? [`offer:${r.moment2.offerId}`] : [],
  )
  for (const entry of sim?.entries ?? []) {
    const card = /card shown req=(\S+)/.exec(entry.message)
    if (card && !ownRequests.has(card[1])) foreignCards.add(card[1])
    const update = /receipt title=Update(?: key=(\S+))?$/.exec(entry.message)
    if (update && !allowedUpdates.has(update[1])) foreignReceipts.add(update[1] ?? 'unnamed')
  }
  note(
    foreignCards.size === 0 && foreignReceipts.size === 0,
    `only this run's requests and receipts appeared on the glasses (other cards: ${foreignCards.size}, other updates: ${foreignReceipts.size})`,
  )
  try {
    const today = DateTime.now().setZone(shop.timezone).toISODate()
    // Root shows upcoming appointments only: one that ended before the run
    // started could never have appeared.
    const startedMs = Date.parse(r.startedAt)
    const real = (await dayEvents(today)).filter(
      (event) => !isDemoEvent(event) && Date.parse(event.endUtc) > startedMs,
    )
    note(
      real.length === 0,
      `today's calendar still holds demo events only, so the root screen named no real customer (non-demo: ${real.length})`,
    )
  } catch (calendarError) {
    note(false, `today's calendar could be checked (${redact(String(calendarError.message ?? calendarError))})`)
  }
}

async function finishOnce(error) {
  if (error) {
    r.error = redact(String(error.message ?? error).split('\n')[0])
    say(`FAIL: ${r.error}`)
  }
  // Stop the server, Vite and the simulator first, so no tap can still fire
  // while cleanup removes the Busy block.
  await stopAll()
  if (!error && sim && calendar) await onlyOwnScreens()
  if (started && calendar) {
    try {
      await cleanup()
    } catch (cleanupError) {
      r.cleanup = `failed: ${redact(String(cleanupError.message ?? cleanupError))}`
      note(false, 'cleanup removed the demo events this run created')
    }
  }
  db?.close()
  r.finishedAt = new Date().toISOString()
  // The verdict comes last, right before anything is published.
  r.ok = !error && r.checks.length > 0 && r.checks.every((c) => c.ok)
  if (started) {
    try {
      if (r.ok) writePassEvidence()
      else writeFailReport(error)
    } catch (writeError) {
      r.ok = false
      r.error = redact(`writing the evidence failed: ${writeError.message}`)
      say(`FAIL: ${r.error}`)
      try {
        writeFailReport(writeError)
      } catch {
        // Nothing more can be written; the exit code still says FAIL.
      }
    }
  }
  say(r.ok ? 'PASS' : 'FAIL')
}

/** Every caller (the run, an error, Ctrl+C) waits for the same single finish. */
function finish(error) {
  finishing ??= finishOnce(error)
  return finishing
}

process.on('SIGINT', () => {
  // A second Ctrl+C quits at once, even if Google is slow to answer cleanup.
  if (interrupted) process.exit(130)
  interrupted = true
  finish(new Error('interrupted (Ctrl+C)')).finally(() => process.exit(130))
})

try {
  preflight()
  await assertPortsFree(['backend', 'vite', 'automation'])
  const simulator = findSimulator()
  say(
    `booking day ${r.env.day} (${r.env.spokenDay}), shop ${shop.name} in ${shop.timezone}`,
  )
  say(
    'name the customer accounts Alex and James (Telegram first names) before you start',
  )
  say('the people will be asked to send, in order:')
  say(`  owner:  /pair CODE (the code appears on the glasses)`)
  say(`  Alex:   ${lines.haircut}`)
  say(`  James:  ${lines.skinFade}`)
  say(`  James:  ${lines.yes}`)
  say(`  Alex:   ${lines.beardTrim}`)
  if (options.finalDm) say(`  James:  ${lines.final}`)
  // The server imports @chairside/shared from dist: a missing or stale build
  // would fail later or strip new protocol fields, after the calendar changed.
  say('building @chairside/shared')
  await run(
    'tsc',
    process.execPath,
    [packageBin('typescript', 'tsc'), '-b', 'packages/shared'],
    { cwd: root, windowsHide: true },
  )
  await checkDayFree()
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  started = true
  await resetAndSeed()
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
  await finish()
} catch (error) {
  await finish(error)
}
process.exit(interrupted ? 130 : r.ok ? 0 : 1)
