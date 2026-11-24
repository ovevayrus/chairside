// Simulator e2e for the glasses app (US-005).
//
//   npm run e2e -- --smoke            root page: ready marker, lit pixels, root double-tap
//   npm run e2e -- --smoke --spike    then the dev spike page (?spike=1): list,
//                                     long press, /healthz and the /ws hello
//
// Starts the backend, the Vite dev server and the Even Hub simulator, drives the
// simulator through its automation API, saves screenshots to docs/evidence/ and
// rewrites the "S3 Simulator" section of docs/SPIKES.md. Only the process trees
// this run started are killed: in a finally, on Ctrl+C and on a crash.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { compare, decode, litPixels } from './lib/frames.mjs'
import {
  fatal,
  portTaken,
  run,
  start,
  stop,
  stopAll,
  waitFor,
} from './lib/processes.mjs'
import { findSimulator, Simulator } from './lib/simulator.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const evidenceDir = join(root, 'docs', 'evidence')
const spikesPath = join(root, 'docs', 'SPIKES.md')
const ports = { backend: 8787, vite: 5173, automation: 9898 }
const appUrl = `http://localhost:${ports.vite}`
const spikeUrl = `${appUrl}/?spike=1`
const apiBase = `http://localhost:${ports.backend}`
const READY_BUDGET_MS = 10_000
const MIN_LIT_PIXELS = 500
const DISMISS_ATTEMPTS = [['double_click'], ['down', 'click'], ['up', 'click']]
// At info level the simulator logs each bridge call and every input it drops.
const SIMULATOR_LOG = 'evenhub_simulator_lib=info'

const step = (message) => console.log(`[e2e] ${message}`)
let interrupted = false

function packageBin(name, bin) {
  const manifestPath = createRequire(import.meta.url).resolve(
    `${name}/package.json`,
  )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relative =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[bin]
  return join(dirname(manifestPath), relative)
}

async function httpOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  return response.ok
}

function save(name, frame) {
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, name), frame.png)
  return `docs/evidence/${name}`
}

/** Waits for the display to leave `from` (if given), then for two identical frames in a row. */
async function settledFrame(sim, from, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let current = decode(await sim.screenshot())
  while (
    from &&
    compare(from, current).changed === 0 &&
    Date.now() < deadline
  ) {
    await delay(100)
    current = decode(await sim.screenshot())
  }
  for (;;) {
    await delay(200)
    const next = decode(await sim.screenshot())
    if (compare(current, next).changed === 0) return next
    if (Date.now() > deadline + 5000) {
      throw new Error('the glasses display did not settle')
    }
    current = next
  }
}

function consoleMatch(sim, what, pattern, from = 0, timeoutMs = 5000) {
  return waitFor(`"${what}" in the simulator console`, timeoutMs, async () => {
    await sim.pollConsole()
    return sim.find(pattern, from)
  })
}

function appLog(sim, from) {
  return sim.entries
    .slice(from)
    .map((entry) => entry.message)
    .filter((message) => message.startsWith('[chairside]'))
}

/** Launches the simulator on `url`, waits for "[chairside] ready", runs `body`, always stops it. */
async function withSimulator(simulator, url, result, body) {
  await waitFor(`port ${ports.automation} to be free`, 10_000, async () => {
    return !(await portTaken(ports.automation))
  })
  step(`launching the simulator on ${url}`)
  const launchedAt = Date.now()
  const args = [url, '--automation-port', String(ports.automation)]
  const proc = start(
    'simulator',
    simulator.command,
    simulator.shell ? args.map((arg) => `"${arg}"`) : args,
    {
      cwd: tmpdir(),
      shell: simulator.shell,
      env: { ...process.env, RUST_LOG: SIMULATOR_LOG },
    },
  )
  try {
    const sim = new Simulator(ports.automation)
    await waitFor('the simulator automation API (/api/ping)', 30_000, () =>
      sim.ping(),
    )
    result.pingMs = Date.now() - launchedAt
    await waitFor(
      `"[chairside] ready" within ${READY_BUDGET_MS} ms of launch`,
      Math.max(READY_BUDGET_MS - result.pingMs, 0),
      async () => {
        await sim.pollConsole()
        const failed = sim.find(/\[chairside\] startup( page)? failed/)
        if (failed) throw fatal(`the app failed to start: ${failed.message}`)
        return sim.find(/\[chairside\] ready/)
      },
      100,
    )
    result.readyMs = Date.now() - launchedAt
    step(
      `ready ${result.readyMs} ms after launch (automation API up after ${result.pingMs} ms)`,
    )
    await body(sim, proc)
  } finally {
    await stop(proc)
  }
}

async function smoke(simulator, result) {
  await withSimulator(simulator, appUrl, result, async (sim, proc) => {
    await consoleMatch(
      sim,
      '[chairside] screen=root',
      /\[chairside\] screen=root/,
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
    result.simulatorLog = proc.lines
      .filter((line) =>
        /ShutDownPageContainer|no active event container/.test(line),
      )
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, ''))
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
  })
}

async function spike(simulator, result) {
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
      `- Ready: ${code('[chairside] ready')} seen ${s.readyMs} ms after the simulator was launched (automation API up after ${s.pingMs} ms; budget ${READY_BUDGET_MS} ms).`,
    )
  }
  if (s.lit !== undefined) {
    lines.push(
      `- Lit pixels at ready (alpha > 0): ${s.lit}, required > ${MIN_LIT_PIXELS}. ${code(s.readyShot)}`,
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
      `- Exit dialog: not simulated. evenhub-simulator ${version} shows no system dialog on the glasses display for ${code('shutDownPageContainer(1)')}: it removes the page, the display stays dark, and it logs ${code('inject_input: no active event container')} for every later input. The box above is therefore the root text being cleared, not a dialog.`,
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
      `- WebSocket: the WebView opened ${code(`ws://localhost:${ports.backend}/ws`)} and sent a hello with a dev token; it logged ${code(p.ws)} (the server answered ${code('{"type":"hello.ok"}')}).`,
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
    `Produced by ${code(`npm run e2e -- ${report.args.join(' ')}`)} (${code('e2e/run.mjs')}): backend on :${ports.backend}, Vite on :${ports.vite}, evenhub-simulator ${report.simulator.version} with ${code(`--automation-port ${ports.automation}`)}, SDK 0.0.16, Node ${process.version} on ${process.platform}. Simulator only: nothing in this section ran on G2 hardware. The runner rewrites this section on every run.`,
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

async function main() {
  const args = process.argv.slice(2)
  const flags = {
    smoke: args.includes('--smoke'),
    spike: args.includes('--spike'),
  }
  const unknown = args.filter((arg) => arg !== '--smoke' && arg !== '--spike')
  if (unknown.length > 0 || (!flags.smoke && !flags.spike)) {
    console.error(
      'usage: npm run e2e -- --smoke [--spike]   (or --spike alone)',
    )
    process.exitCode = 2
    return
  }
  for (const [name, port] of Object.entries(ports)) {
    if (await portTaken(port)) {
      throw new Error(
        `port ${port} (${name}) is already in use: stop that process first; this runner only stops what it starts`,
      )
    }
  }
  const simulator = findSimulator()

  step('building @chairside/shared (the backend imports its dist)')
  await run(
    'tsc',
    process.execPath,
    [packageBin('typescript', 'tsc'), '-b', 'packages/shared'],
    { cwd: root, windowsHide: true },
  )
  step(`starting the backend on :${ports.backend}`)
  start('backend', process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(root, 'apps', 'server'),
    env: {
      ...process.env,
      PORT: String(ports.backend),
      NODE_ENV: 'development',
    },
    windowsHide: true,
  })
  await waitFor('the backend /healthz', 20_000, () =>
    httpOk(`http://127.0.0.1:${ports.backend}/healthz`),
  )
  step(`starting Vite on :${ports.vite}`)
  start(
    'vite',
    process.execPath,
    [packageBin('vite', 'vite'), '--port', String(ports.vite), '--strictPort'],
    {
      cwd: join(root, 'apps', 'glasses'),
      env: { ...process.env, VITE_API_BASE: apiBase },
      windowsHide: true,
    },
  )
  await waitFor('the Vite dev server', 30_000, () =>
    httpOk(`http://127.0.0.1:${ports.vite}/`),
  )

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
        await phases[name](simulator, result)
        result.status = result.dialogNotSimulated
          ? 'PASS (exit dialog not simulated, see below)'
          : 'PASS'
      } catch (error) {
        if (interrupted) throw error
        failed.push(name)
        result.status = 'FAIL'
        result.error = error.message.split('\n')[0]
        console.error(`[e2e] ${name} failed: ${error.message}`)
      }
    }
  } finally {
    if (!interrupted) writeS3(report)
  }
  if (failed.length > 0) throw new Error(`${failed.join(', ')} failed`)
  const limited = report.phases.smoke?.dialogNotSimulated
  step(
    limited
      ? 'PASS with 1 limitation: exit dialog not simulated (see S3)'
      : 'PASS',
  )
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    if (interrupted) return
    interrupted = true
    console.error(`\n[e2e] ${signal}: stopping the processes this run started`)
    stopAll().finally(() => process.exit(130))
  })
}
process.on('uncaughtException', (error) => {
  console.error(`[e2e] crashed: ${error.stack ?? error}`)
  stopAll().finally(() => process.exit(1))
})

try {
  await main()
} catch (error) {
  if (!interrupted) {
    console.error(`[e2e] FAIL: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  if (!interrupted) {
    await stopAll()
    process.exit(process.exitCode ?? 0)
  }
}
