// Measures the glasses font in the Even Hub simulator (dev tool, not a test).
//
//   node e2e/measure-font.mjs
//
// The official measurement library (@evenrealities/pretext) is not a dependency
// here, so the layout code uses advance widths read off the simulator instead:
// the dev page ?measure=1 (apps/glasses/src/measure.ts) draws "||" and
// "|" + glyph x REPEAT + "|" per row, and (row right edge - "||" right edge) /
// REPEAT is the glyph's advance in pixels. Writes the table to
// apps/glasses/src/ui/glyph-widths.ts and the evidence to docs/evidence/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { litPixels } from './lib/frames.mjs'
import {
  appUrl,
  assertPortsFree,
  consoleMatch,
  launchSimulator,
  packageBin,
  root,
  settledFrame,
  startVite,
  step,
} from './lib/harness.mjs'
import { run, stop, stopAll } from './lib/processes.mjs'
import { findSimulator } from './lib/simulator.mjs'

const WHITELIST = ['●', '○', '■', '□', '▶', '▷', '━', '─', '│', '·']
const tablePath = join(root, 'apps', 'glasses', 'src', 'ui', 'glyph-widths.ts')
const evidenceDir = join(root, 'docs', 'evidence')
const LINE_HEIGHT = 27

/** Right-most and lowest lit pixel and the lit count inside one row band. */
function rowInk(frame, y0, pitch) {
  let right = -1
  let bottom = -1
  for (let y = y0; y < Math.min(y0 + pitch, frame.height); y++) {
    for (let x = 0; x < frame.width; x++) {
      if (frame.data[(y * frame.width + x) * 4 + 3] > 0) {
        if (x > right) right = x
        if (y > bottom) bottom = y
      }
    }
  }
  const lit = litPixels(frame, {
    x0: 0,
    y0,
    x1: frame.width - 1,
    y1: Math.min(y0 + pitch, frame.height) - 1,
  })
  return { right, bottom: bottom - y0, lit }
}

function parsePage(message) {
  const match = /page=(\d+) rows=([0-9a-f,]+) pitch=(\d+) repeat=(\d+)/.exec(
    message,
  )
  if (!match) throw new Error(`unexpected measure line: ${message}`)
  return {
    page: Number(match[1]),
    glyphs: match[2]
      .split(',')
      .map((hex) => String.fromCodePoint(parseInt(hex, 16))),
    pitch: Number(match[3]),
    repeat: Number(match[4]),
  }
}

function literal(glyph) {
  return JSON.stringify(glyph)
}

async function main() {
  await assertPortsFree(['vite', 'automation'])
  const simulator = findSimulator()
  await startVite()
  const url = `${appUrl}/?measure=1`
  const measured = []
  let storage
  let storageRoundTrip
  const first = await launchSimulator(simulator, url)
  try {
    const { sim } = first
    storage = (
      await consoleMatch(sim, 'measure storage', /measure storage=/)
    ).message.split('=')[1]
    storageRoundTrip = (
      await consoleMatch(sim, 'measure roundtrip', /measure roundtrip=/)
    ).message.split('=')[1]
    let entry = await consoleMatch(
      sim,
      '[chairside] measure page=0',
      /\[chairside\] measure page=\d+ /,
    )
    let previous
    for (;;) {
      const { page, glyphs, pitch, repeat } = parsePage(entry.message)
      const frame = await settledFrame(sim, previous)
      previous = frame
      if (page === 0 || glyphs.some((g) => WHITELIST.includes(g))) {
        mkdirSync(evidenceDir, { recursive: true })
        writeFileSync(
          join(evidenceDir, `font-measure-page${page}.png`),
          frame.png,
        )
      }
      const ref = rowInk(frame, 0, pitch)
      glyphs.forEach((glyph, i) => {
        const ink = rowInk(frame, (i + 1) * pitch, pitch)
        measured.push({
          glyph,
          advance: Math.round(((ink.right - ref.right) / repeat) * 100) / 100,
          drawn: ink.lit > ref.lit,
          wrapped: ink.bottom >= LINE_HEIGHT + 2,
        })
      })
      step(`page ${page}: ${glyphs.map(literal).join(' ')}`)
      const done = sim.entries.length
      await sim.input('click')
      entry = await consoleMatch(
        sim,
        'the next measure page',
        /\[chairside\] measure (page=\d+ |done)/,
        done,
      )
      if (/measure done/.test(entry.message)) break
    }
  } finally {
    await stop(first.proc)
  }

  // Relaunch once: does the simulator keep bridge local storage between launches?
  const second = await launchSimulator(simulator, url)
  let storageAfterRelaunch
  try {
    storageAfterRelaunch = (
      await consoleMatch(second.sim, 'measure storage', /measure storage=/)
    ).message.split('=')[1]
  } finally {
    await stop(second.proc)
  }

  const bad = measured.filter((m) => m.wrapped)
  if (bad.length) {
    throw new Error(
      `rows wrapped for ${bad.map((m) => literal(m.glyph)).join(' ')}; lower REPEAT`,
    )
  }
  const isAscii = (m) => m.glyph.codePointAt(0) < 0x7f
  // ASCII glyphs the font lacks draw nothing; they stay out of the table (and
  // so out of the app's whitelist). Whitelisted symbols must all draw.
  const absent = measured.filter(
    (m) => isAscii(m) && m.glyph !== ' ' && !m.drawn,
  )
  const table = measured.filter(
    (m) => (isAscii(m) && !absent.includes(m)) || WHITELIST.includes(m.glyph),
  )
  const missing = table.filter((m) => m.glyph !== ' ' && !m.drawn)
  const date = new Date().toISOString()
  const lines = table.map((m) => `  ${literal(m.glyph)}: ${m.advance},`)
  mkdirSync(dirname(tablePath), { recursive: true })
  writeFileSync(
    tablePath,
    [
      `// Generated by \`node e2e/measure-font.mjs\` (evenhub-simulator ${simulator.version}, ${date}).`,
      '// Advance widths in px of the glasses font as the simulator draws it. Regenerate; do not edit.',
      'export const GLYPH_WIDTHS: Readonly<Record<string, number>> = {',
      ...lines,
      '}',
      '',
    ].join('\n'),
  )
  // Keep the generated file in the repo's style, so a rerun diffs cleanly.
  await run(
    'prettier',
    process.execPath,
    [packageBin('prettier', 'prettier'), '--write', tablePath],
    { cwd: root, windowsHide: true },
  )
  step(`wrote ${tablePath}`)

  const name = (m) =>
    m.glyph === '|'
      ? '\\|'
      : m.glyph === ' '
        ? 'space'
        : m.glyph === '`'
          ? 'backtick'
          : m.glyph
  const row = (m) =>
    `| ${name(m)} | U+${m.glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} | ${m.advance} | ${m.glyph === ' ' ? 'n/a' : m.drawn ? 'yes' : 'NO'} |`
  const probes = measured.filter(
    (m) => !table.includes(m) && !absent.includes(m),
  )
  writeFileSync(
    join(evidenceDir, 'font-widths.md'),
    [
      '# Glasses font widths (simulator)',
      '',
      `Measured ${date} by \`node e2e/measure-font.mjs\` in evenhub-simulator ${simulator.version} (simulator only, not G2 hardware). The dev page \`?measure=1\` draws a reference row \`||\` and one row \`|\` + glyph x 16 + \`|\` per glyph; advance = (row right edge - reference right edge) / 16. The table feeds \`apps/glasses/src/ui/glyph-widths.ts\`; the layout code keeps a safety margin because the hardware font may differ slightly. Page screenshots: \`docs/evidence/font-measure-page*.png\`.`,
      '',
      `- Whitelisted display symbols: ${WHITELIST.join(' ')}. ${missing.length ? `NOT drawn: ${missing.map(name).join(' ')}.` : 'Every one drew lit pixels.'}`,
      `- ASCII glyphs the font does not draw (advance only, no pixels), so the app's sanitizer drops them: ${absent.length ? absent.map(name).join(', ') : 'none'}.`,
      `- Bridge local storage: a value written on the first launch was read back as "${storageRoundTrip}" in the same session; after a simulator relaunch the first read was "${storageAfterRelaunch}" (first launch: "${storage}").`,
      '',
      '| Glyph | Code point | Advance px | Drawn |',
      '| --- | --- | --- | --- |',
      ...table.map(row),
      ...absent.map(row),
      '',
      'Probes outside the whitelist (recorded only; the app never sends them):',
      '',
      '| Glyph | Code point | Advance px | Drawn |',
      '| --- | --- | --- | --- |',
      ...probes.map(row),
      '',
    ].join('\n'),
  )
  step('wrote docs/evidence/font-widths.md')
  if (missing.length) {
    throw new Error(
      `whitelisted glyphs drew nothing: ${missing.map((m) => literal(m.glyph)).join(' ')}`,
    )
  }
}

try {
  await main()
} catch (error) {
  console.error(`[e2e] FAIL: ${error.message}`)
  process.exitCode = 1
} finally {
  await stopAll()
}
