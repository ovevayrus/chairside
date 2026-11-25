// The 2-minute idle check (Even Hub QA: "after 2 minutes idle the app remains
// alive and responsive"): TEST MODE, pair, wait with no input, then inject a DM
// and tap. Saves docs/evidence/e2e-idle-after-2min.png.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { litPixels } from './frames.mjs'
import {
  appUrl,
  consoleMatch,
  launchSimulator,
  root,
  settledFrame,
  step,
} from './harness.mjs'
import { stop } from './processes.mjs'
import { bookingDay, spoken } from './full.mjs'

const IDLE_MS = 125_000

export async function idleRun(simulator, backend) {
  const { sim, proc } = await launchSimulator(simulator, `${appUrl}/?fresh=1`)
  try {
    await consoleMatch(
      sim,
      'pair code issued',
      /\[chairside\] pair code issued/,
      0,
    )
    let mark = sim.entries.length
    await backend.dev('POST', '/dev/pair')
    await consoleMatch(sim, 'screen=root', /\[chairside\] screen=root/, mark)
    await consoleMatch(sim, 'link=live', /\[chairside\] link=live/, mark)
    step(`paired; idle for ${IDLE_MS / 1000} s with no input`)
    const idleFrom = sim.entries.length
    await delay(IDLE_MS)
    await sim.pollConsole()

    const before = await backend.fakes()
    mark = sim.entries.length
    await backend.dev('POST', '/dev/inject', {
      firstName: 'Anna',
      text: `Can I get a skin fade ${spoken(bookingDay(new Date()))} at 3pm?`,
    })
    const shown = await consoleMatch(
      sim,
      'card shown',
      /\[chairside\] card shown req=(\S+) v=1\b/,
      mark,
      20_000,
    )
    const requestId = /req=(\S+)/.exec(shown.message)[1]
    const frame = await settledFrame(sim)
    const lit = litPixels(frame)
    writeFileSync(
      join(root, 'docs', 'evidence', 'e2e-idle-after-2min.png'),
      frame.png,
    )
    if (lit <= 500) throw new Error(`card frame has only ${lit} lit pixels`)

    mark = sim.entries.length
    await sim.input('click')
    await consoleMatch(
      sim,
      'action result ok',
      new RegExp(
        String.raw`\[chairside\] action result req=${requestId} status=ok$`,
      ),
      mark,
      15_000,
    )
    const after = await backend.fakes()
    const isSend = (call) =>
      ['sendText', 'sendWithButton'].includes(call.method)
    const sends =
      after.telegram.calls.filter(isSend).length -
      before.telegram.calls.filter(isSend).length
    if (sends !== 1)
      throw new Error(`expected exactly 1 fake send, got ${sends}`)
    await sim.pollConsole()
    const errors = sim.entries
      .slice(idleFrom)
      .filter((entry) => /error/i.test(entry.level))
    const allErrors = sim.entries.filter((entry) => /error/i.test(entry.level))
    if (allErrors.length > 0)
      throw new Error(
        `console errors: ${allErrors.map((e) => e.message).join(' | ')}`,
      )
    step(
      `idle PASS: card after ${IDLE_MS / 1000} s idle (${lit} lit px), 1 send, ${errors.length} console errors`,
    )
  } finally {
    await stop(proc)
  }
}
