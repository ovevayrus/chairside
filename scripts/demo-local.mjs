// Chairside local demo: `npm run demo:local`. No Telegram or Google account
// needed. Starts the TEST MODE backend (fake Telegram, fake calendar, temp
// database), Vite and the Even Hub simulator, pairs the glasses by itself and
// then plays a short story of customer DMs so a person can act on each card.
// Every glasses header shows TEST. Runs until Ctrl+C.
//
//   npm run demo:local               the full story, until Ctrl+C
//   npm run demo:local -- --check    headless check: start, pair, inject the
//                                    first DM, see a TEST card, save
//                                    docs/evidence/demo-local-check.png, exit 0
//                                    (needs the GUI simulator; not in npm test)
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Backend } from '../e2e/lib/backend.mjs'
import { bookingDay, shopTime, spoken } from '../e2e/lib/full.mjs'
import {
  appUrl,
  assertPortsFree,
  launchSimulator,
  packageBin,
  root,
  settledFrame,
  startVite,
} from '../e2e/lib/harness.mjs'
import { run, stopAll, waitFor } from '../e2e/lib/processes.mjs'
import { findSimulator } from '../e2e/lib/simulator.mjs'

const CARD_TIMEOUT_MS = 15_000
const PERSON_TIMEOUT_MS = 60_000

const say = (message) => console.log(`[demo] ${message}`)

let interrupted = false
let backend
let sim
let simProc

/** Waits for an app console line; returns undefined on timeout instead of throwing. */
async function waitLine(pattern, from, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sim.pollConsole()
    const hit = sim.find(pattern, from)
    if (hit) return hit
    await delay(250)
  }
  return undefined
}

async function waitCard(from) {
  const hit = await waitLine(
    /\[chairside\] card shown req=(\S+) v=1\b/,
    from,
    CARD_TIMEOUT_MS,
  )
  if (!hit) throw new Error('no card appeared on the glasses in time')
  return /req=(\S+)/.exec(hit.message)[1]
}

async function startStack() {
  const simulator = findSimulator()
  await assertPortsFree(['backend', 'vite', 'automation'])
  say('building the shared package')
  await run(
    'tsc',
    process.execPath,
    [packageBin('typescript', 'tsc'), '-b', 'packages/shared'],
    { cwd: root, windowsHide: true },
  )
  backend = new Backend()
  await backend.start()
  await startVite()
  const launched = await launchSimulator(simulator, `${appUrl}/?fresh=1`)
  sim = launched.sim
  simProc = launched.proc
  await waitLine(/\[chairside\] pair code issued/, 0, 10_000)
  const mark = sim.entries.length
  await backend.dev('POST', '/dev/pair')
  if (!(await waitLine(/\[chairside\] screen=root/, mark, 10_000))) {
    throw new Error('the glasses did not reach the root screen after pairing')
  }
  say('glasses paired (TEST MODE: fake Telegram, fake calendar)')
}

function instructions() {
  say('')
  say('The simulator window is the pair of glasses. Click = tap,')
  say('arrow keys = swipe, double-click = back. Every header says TEST.')
  say('Watch for cards on the glasses and act on each one. Ctrl+C stops.')
  say('')
}

async function story() {
  const day = bookingDay(new Date())
  const when = spoken(day)

  say(
    `1/3 Anna asks for a skin fade ${when} at 3pm. A card opens: tap to book it.`,
  )
  let mark = sim.entries.length
  await backend.dev('POST', '/dev/inject', {
    firstName: 'Anna',
    text: `Can I get a skin fade ${when} at 3pm?`,
  })
  const first = await waitCard(mark)
  const booked = await waitLine(
    new RegExp(`action result req=${first} status=\\w+`),
    mark,
    PERSON_TIMEOUT_MS,
  )
  say(
    booked
      ? 'Booked. Anna got her confirmation (fake).'
      : 'No tap within 60 s, moving on.',
  )

  say(
    `2/3 Omar asks for the same slot, ${when} at 3pm. It is taken, so expect an offer card. Tap the offer.`,
  )
  mark = sim.entries.length
  await backend.dev('POST', '/dev/inject', {
    firstName: 'Omar',
    text: `Can I get a skin fade ${when} at 3pm?`,
  })
  const offer = await waitCard(mark)
  const tapped = await waitLine(
    new RegExp(`action sent req=${offer} action=\\S+`),
    mark,
    PERSON_TIMEOUT_MS,
  )
  say(
    tapped
      ? 'Offer sent (fake). Omar replies yes.'
      : 'No tap within 60 s. Omar replies yes anyway.',
  )
  await backend.dev('POST', '/dev/inject', { firstName: 'Omar', text: 'yes' })
  await delay(4000)

  say(
    `3/3 Anna asks for a beard trim ${when} at 5pm. 5 s after the card shows, someone else takes that time, so your tap will find the slot taken.`,
  )
  mark = sim.entries.length
  await backend.dev('POST', '/dev/inject', {
    firstName: 'Anna',
    text: `can you also do a beard trim ${when} at 5pm?`,
  })
  await waitCard(mark)
  await delay(5000)
  await backend.dev('POST', '/dev/calendar/block', {
    startUtc: shopTime(day, 17).toISOString(),
    minutes: 30,
  })
  say(
    'A 30-minute block just appeared at 5pm. Tap the card to see the stale-card guard.',
  )
  say('Story finished. The demo keeps running: Ctrl+C to stop.')
}

/** --check: step 1 only, headless; proves a TEST card reaches the glasses. */
async function check() {
  const day = bookingDay(new Date())
  const mark = sim.entries.length
  await backend.dev('POST', '/dev/inject', {
    firstName: 'Anna',
    text: `Can I get a skin fade ${spoken(day)} at 3pm?`,
  })
  await waitCard(mark)
  const frame = await settledFrame(sim, undefined, 4000)
  const png = join(root, 'docs', 'evidence', 'demo-local-check.png')
  writeFileSync(png, frame.png)
  // The simulator logs each bridge call with the text it draws.
  await waitFor('a TEST header in the simulator output', 5000, async () =>
    simProc.lines.some((line) => /\bTEST\b/.test(line)),
  )
  say('CHECK PASS: started, paired, injected the first DM, TEST header seen')
  say('screenshot: docs/evidence/demo-local-check.png')
}

async function cleanup() {
  await stopAll()
  await backend?.dispose().catch(() => {})
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    if (interrupted) return
    interrupted = true
    console.error(`\n[demo] ${signal}: stopping what the demo started`)
    cleanup().finally(() => process.exit(0))
  })
}
process.on('uncaughtException', (error) => {
  console.error(`[demo] crashed: ${error.stack ?? error}`)
  cleanup().finally(() => process.exit(1))
})

try {
  const checking = process.argv.slice(2).includes('--check')
  await startStack()
  if (checking) {
    await check()
  } else {
    instructions()
    await story()
    await new Promise(() => {})
  }
} catch (error) {
  if (!interrupted) {
    console.error(`[demo] FAIL: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  if (!interrupted) {
    await cleanup()
    process.exit(process.exitCode ?? 0)
  }
}
