// The US-005 simulator checks (spike S3), kept as `--smoke` and `--spike`:
// smoke pairs through the dev endpoint, then checks the root page (lit
// pixels, root double-tap); spike drives the dev page ?spike=1 (list, long
// press, /healthz, the /ws hello). Both rewrite the "S3 Simulator" section of
// docs/SPIKES.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { compare, litPixels } from './frames.mjs'
import {
  apiBase,
  appLog,
  appUrl,
  consoleMatch,
  launchSimulator,
  ports,
  READY_BUDGET_MS,
  root,
  settledFrame,
  simulatorLines,
  step,
} from './harness.mjs'
import { stop } from './processes.mjs'

const evidenceDir = join(root, 'docs', 'evidence')
const spikesPath = join(root, 'docs', 'SPIKES.md')
const spikeUrl = `${appUrl}/?spike=1`
const MIN_LIT_PIXELS = 500
const DISMISS_ATTEMPTS = [['double_click'], ['down', 'click'], ['up', 'click']]

function save(name, frame) {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, name), frame.png)
  return `docs/evidence/${name}`
}

async function withSimulator(simulator, url, result, body) {
  const { sim, proc, pingMs, readyMs } = await launchSimulator(simulator, url)
  result.pingMs = pingMs
  result.readyMs = readyMs
  try {
    await body(sim, proc)
  } finally {
    await stop(proc)
  }
}

async function smoke(simulator, backend, result) {
  await withSimulator(
    simulator,
    `${appUrl}/?fresh=1`,
    result,
    async (sim, proc) => {
      await consoleMatch(
        sim,
        '[chairside] pair code issued',
        /pair code issued/,
      )
      await backend.dev('POST', '/dev/pair')
      await consoleMatch(
        sim,
        '[chairside] screen=root',
        /\[chairside\] screen=root/,
        0,
        10_000,
      )
      await consoleMatch(
        sim,
        '[chairside] link=live',
        /\[chairside\] link=live/,
      )
      const ready = await settledFrame(sim)
      result.lit = litPixels(ready)
      result.readyShot = save('e2e-smoke-ready.png', ready)
      step(`${result.lit} lit pixels at ready`)
      if (result.lit <= MIN_LIT_PIXELS) {
        throw new Error(
          `only ${result.lit} lit pixels at ready (needs more than ${MIN_LIT_PIXELS})`,
        )
      }

      const mark = sim.entries.length
      await sim.input('double_click')
      const afterTap = await settledFrame(sim, ready)
      const { changed, box } = compare(ready, afterTap)
      if (!box) {
        throw new Error(
          'double_click on the root page did not change the display',
        )
      }
      await consoleMatch(
        sim,
        '[chairside] exit dialog requested',
        /\[chairside\] exit dialog requested/,
        mark,
      )
      result.doubleTap = {
        changed,
        box,
        litBefore: litPixels(ready, box),
        litAfter: litPixels(afterTap, box),
        shot: save('e2e-smoke-double-tap.png', afterTap),
      }
      step(`double_click changed ${changed} pixels in ${JSON.stringify(box)}`)
      if (result.doubleTap.litBefore === result.doubleTap.litAfter) {
        throw new Error(
          'the lit-pixel count inside the changed region did not change',
        )
      }

      result.attempts = []
      let shown = afterTap
      for (const gestures of DISMISS_ATTEMPTS) {
        for (const gesture of gestures) {
          await sim.input(gesture)
          await delay(300)
        }
        shown = await settledFrame(sim, shown, 2000)
        const differing = compare(ready, shown).changed
        result.attempts.push({ gestures, differing, lit: litPixels(shown) })
        step(
          `dismiss attempt ${gestures.join(' + ')}: ${differing} pixels differ from ready`,
        )
        if (differing === 0) {
          result.dismissedBy = gestures
          result.dismissedShot = save('e2e-smoke-dismissed.png', shown)
          break
        }
      }
      await delay(300)
      await sim.pollConsole()
      result.appLog = appLog(sim, mark)
      result.simulatorLog = simulatorLines(
        proc,
        /ShutDownPageContainer|no active event container/,
      )
      if (result.dismissedBy) return

      result.afterShot = save('e2e-smoke-after-attempts.png', shown)
      // evenhub-simulator 0.9.5 has no system exit dialog: shutDownPageContainer
      // removes the page and every later input has no target. Recognise exactly
      // that, from the simulator's own log, so it is reported instead of hidden.
      const removed =
        result.simulatorLog.some((line) =>
          line.includes('ShutDownPageContainer'),
        ) &&
        result.simulatorLog.some((line) =>
          line.includes('no active event container'),
        ) &&
        result.attempts.every((attempt) => attempt.lit === 0)
      if (!removed) {
        throw new Error(
          'no gesture dismissed the exit dialog back to the root page',
        )
      }
      result.dialogNotSimulated = true
      step(
        'LIMITATION: no exit dialog on the simulated glasses; shutDownPageContainer(1) removed the page, so the cancel gesture needs hardware',
      )
    },
  )
}

async function spike(simulator, _backend, result) {
  await withSimulator(simulator, spikeUrl, result, async (sim) => {
    await consoleMatch(
      sim,
      '[chairside] screen=spike',
      /\[chairside\] screen=spike/,
    )

    const health = await consoleMatch(
      sim,
      '[chairside] healthz',
      /\[chairside\] healthz /,
      0,
      10_000,
    )
    result.healthz = health.message
    if (!/healthz ok/.test(health.message)) {
      throw new Error(`the WebView could not reach /healthz: ${health.message}`)
    }
    const live = await consoleMatch(
      sim,
      '[chairside] ws hello',
      /\[chairside\] ws (hello|closed)/,
      0,
      10_000,
    )
    result.ws = live.message
    if (!/ws hello ok/.test(live.message)) {
      throw new Error(`the /ws hello failed: ${live.message}`)
    }
    const response = await fetch(`http://127.0.0.1:${ports.backend}/healthz`, {
      headers: { Origin: appUrl },
      signal: AbortSignal.timeout(2000),
    })
    result.cors = response.headers.get('access-control-allow-origin')
    if (result.cors !== '*') {
      throw new Error(
        `/healthz sent Access-Control-Allow-Origin: ${result.cors}`,
      )
    }

    const list = await settledFrame(sim)
    result.listShot = save('e2e-spike-list.png', list)
    const mark = sim.entries.length
    await sim.input('down')
    const down1 = await settledFrame(sim, list)
    await sim.input('down')
    const down2 = await settledFrame(sim, down1)
    result.moves = [compare(list, down1).changed, compare(down1, down2).changed]
    result.downShot = save('e2e-spike-down2.png', down2)
    step(`list: down changed ${result.moves[0]} then ${result.moves[1]} pixels`)
    if (result.moves.includes(0)) {
      throw new Error('the list highlight did not move on down')
    }
    await sim.pollConsole()
    result.scrollLog = appLog(sim, mark).filter((message) =>
      message.startsWith('[chairside] list '),
    )

    const clickMark = sim.entries.length
    await sim.input('click')
    const click = await consoleMatch(
      sim,
      '[chairside] list index=<n> event=click',
      /\[chairside\] list index=\d+ event=click/,
      clickMark,
    )
    result.click = click.message
    result.clickIndex = Number(/index=(\d+)/.exec(click.message)[1])
    if (result.clickIndex !== 2) {
      throw new Error(`click returned index ${result.clickIndex}, expected 2`)
    }

    // Keep the long press well apart from the tap: tap then long press is the
    // system gesture for the contextual menu.
    await delay(1500)
    const pressMark = sim.entries.length
    await sim.input('long_press')
    const pressStart = await consoleMatch(
      sim,
      '[chairside] long-press start',
      /\[chairside\] long-press start/,
      pressMark,
    )
    result.pressStart = pressStart.message
    await sim.input('long_press_release')
    const pressRelease = await consoleMatch(
      sim,
      '[chairside] long-press release',
      /\[chairside\] long-press release/,
      pressMark,
    )
    result.pressRelease = pressRelease.message
  })
}

const code = (value) => `\`${value}\``

function attemptsText(attempts) {
  return attempts
    .map(
      (attempt) =>
        `${code(attempt.gestures.join(' + '))} -> ${attempt.differing} px differ from ready`,
    )
    .join('; ')
}

function smokeLines(s, version) {
  const lines = []
  if (s.readyMs !== undefined) {
    lines.push(
      `- Ready: ${code('[chairside] ready')} seen ${s.readyMs} ms after the simulator was launched (automation API up after ${s.pingMs} ms; budget ${READY_BUDGET_MS} ms). The app opens on the pairing screen; the runner pairs it through ${code('POST /dev/pair')}.`,
    )
  }
  if (s.lit !== undefined) {
    lines.push(
      `- Lit pixels on the paired root page (alpha > 0): ${s.lit}, required > ${MIN_LIT_PIXELS}. ${code(s.readyShot)}`,
    )
  }
  if (s.doubleTap) {
    const { box } = s.doubleTap
    lines.push(
      `- Root ${code('double_click')}: the app logged ${code('[chairside] exit dialog requested')} and called ${code('shutDownPageContainer(1)')}. Pixels changed against the ready frame: ${s.doubleTap.changed}, inside the box x ${box.x0}..${box.x1}, y ${box.y0}..${box.y1} (${box.x1 - box.x0 + 1} x ${box.y1 - box.y0 + 1} px). Lit pixels inside that box: ${s.doubleTap.litBefore} at ready, ${s.doubleTap.litAfter} after the double-tap. ${code(s.doubleTap.shot)}`,
    )
  }
  if (s.dismissedBy) {
    lines.push(
      `- Dismiss gesture: ${code(s.dismissedBy.join(' + '))} brings back the root page (frame identical to the ready frame). Attempts in order: ${attemptsText(s.attempts)}. ${code(s.dismissedShot)}`,
    )
  } else if (s.dialogNotSimulated) {
    lines.push(
      `- Exit dialog: not simulated. evenhub-simulator ${version} shows no system dialog on the glasses display for ${code('shutDownPageContainer(1)')}: it removes the page, the display stays dark, and it logs ${code('inject_input: no active event container')} for every later input. The box above is therefore the root page being cleared, not a dialog.`,
      `- Dismiss gesture: none found in the simulator. Attempts in order: ${attemptsText(s.attempts)}. Unverified here: the system dialog and its cancel gesture must be checked on G2 hardware. ${code(s.afterShot)}`,
    )
  } else if (s.attempts?.length) {
    lines.push(
      `- No gesture dismissed the dialog. Attempts in order: ${attemptsText(s.attempts)}.`,
    )
  }
  if (s.appLog) {
    lines.push(
      `- App console from the double-tap on: ${s.appLog.map(code).join(', ') || 'none'}.`,
    )
  }
  if (s.simulatorLog?.length) {
    const counts = new Map()
    for (const line of s.simulatorLog)
      counts.set(line, (counts.get(line) ?? 0) + 1)
    const entries = [...counts].map(([line, n]) =>
      n > 1 ? `${code(line)} (x${n})` : code(line),
    )
    lines.push(`- Simulator log from the double-tap on: ${entries.join(', ')}.`)
  }
  return lines
}

function spikeLines(p) {
  const lines = []
  if (p.readyMs !== undefined) {
    lines.push(
      `- Ready: ${code('[chairside] ready')} and ${code('[chairside] screen=spike')} ${p.readyMs} ms after launch (automation API up after ${p.pingMs} ms).`,
    )
  }
  if (p.healthz) {
    const cors = p.cors
      ? `; the runner's own request with ${code(`Origin: ${appUrl}`)} got ${code(`Access-Control-Allow-Origin: ${p.cors}`)}`
      : ''
    lines.push(
      `- healthz: the WebView fetched ${code(`GET ${apiBase}/healthz`)} cross-origin from ${code(appUrl)} and logged ${code(p.healthz)}${cors}.`,
    )
  }
  if (p.ws) {
    lines.push(
      `- WebSocket: the WebView opened ${code(`ws://localhost:${ports.backend}/ws`)} and sent a hello with a dev token (accepted only in TEST MODE); it logged ${code(p.ws)} (the server answered ${code('{"type":"hello.ok"}')}).`,
    )
  }
  if (p.moves) {
    const scrolls = p.scrollLog?.length
      ? p.scrollLog.map(code).join(', ')
      : 'none (the list scrolls inside the firmware)'
    lines.push(
      `- List (3 items, highlight starts on index 0): two ${code('down')} inputs changed ${p.moves[0]} and ${p.moves[1]} pixels (the highlight moved); app list events during the scrolls: ${scrolls}. ${code(p.listShot)}, ${code(p.downShot)}`,
    )
  }
  if (p.click) {
    lines.push(
      `- Click after the two downs: ${code(p.click)}, so the highlight had moved from index 0 to index ${p.clickIndex} (expected 2).`,
    )
  }
  if (p.pressStart) {
    const release = p.pressRelease
      ? `${code('long_press_release')} -> ${code(p.pressRelease)}`
      : 'no release logged'
    lines.push(
      `- Long press: ${code('long_press')} -> ${code(p.pressStart)}; ${release}.`,
    )
  }
  return lines
}

function s3Section(report) {
  const { smoke: s, spike: p } = report.phases
  const lines = [
    `## S3 Simulator (automated run ${report.startedAt})`,
    '',
    `Produced by ${code(`npm run e2e -- ${report.args.join(' ')}`)} (${code('e2e/run.mjs')}): backend in TEST MODE on :${ports.backend}, Vite on :${ports.vite}, evenhub-simulator ${report.simulator.version} with ${code(`--automation-port ${ports.automation}`)}, SDK 0.0.16, Node ${process.version} on ${process.platform}. Simulator only: nothing in this section ran on G2 hardware. The runner rewrites this section on every run.`,
    '',
    `### Smoke, root page (${code(appUrl)}): ${s?.status ?? 'not run (pass --smoke)'}`,
    '',
    ...(s ? smokeLines(s, report.simulator.version) : []),
    ...(s?.error ? [`- Failed: ${s.error}`] : []),
    '',
    `### Spike, dev page (${code(spikeUrl)}): ${p?.status ?? 'not run (pass --spike)'}`,
    '',
    ...(p ? spikeLines(p) : []),
    ...(p?.error ? [`- Failed: ${p.error}`] : []),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}

function writeS3(report) {
  const text = readFileSync(spikesPath, 'utf8')
  const start = text.search(/^## S3 Simulator\b/m)
  if (start === -1) {
    throw new Error('docs/SPIKES.md has no "## S3 Simulator" section')
  }
  const next = text.slice(start + 3).search(/^## /m)
  const end = next === -1 ? text.length : start + 3 + next
  const rest = text.slice(end)
  writeFileSync(
    spikesPath,
    `${text.slice(0, start)}${s3Section(report)}${rest ? `\n${rest}` : ''}`,
  )
  step('wrote the S3 section of docs/SPIKES.md')
}

/** Runs the requested S3 phases; rewrites S3 unless interrupted. */
export async function s3Run(simulator, backend, flags, args, isInterrupted) {
  const report = {
    startedAt: new Date().toISOString(),
    args,
    simulator,
    phases: {},
  }
  const phases = { smoke, spike }
  const failed = []
  try {
    for (const name of ['smoke', 'spike']) {
      if (!flags[name]) continue
      const result = (report.phases[name] = { status: 'running' })
      try {
        await phases[name](simulator, backend, result)
        result.status = result.dialogNotSimulated
          ? 'PASS (exit dialog not simulated, see below)'
          : 'PASS'
      } catch (error) {
        if (isInterrupted()) throw error
        failed.push(name)
        result.status = 'FAIL'
        result.error = error.message.split('\n')[0]
        console.error(`[e2e] ${name} failed: ${error.message}`)
      }
    }
  } finally {
    if (!isInterrupted()) writeS3(report)
  }
  if (failed.length > 0) throw new Error(`${failed.join(', ')} failed`)
  return report.phases.smoke?.dialogNotSimulated
    ? 'PASS with 1 limitation: exit dialog not simulated (see S3)'
    : 'PASS'
}
