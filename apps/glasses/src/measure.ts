// Dev-only font measurement page: loaded with ?measure=1 under `vite` dev, never
// in a build. `node e2e/measure-font.mjs` drives it. Each page shows a
// reference row "||" and rows "|" + glyph x REPEAT + "|"; the runner reads the
// lit-pixel right edges, so (row edge - reference edge) / REPEAT is the glyph's
// advance width in the simulator's firmware font.
import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { normalizeEvent } from './input'

export const REPEAT = 16
const ROW_PITCH = 48
const ROWS_PER_PAGE = 6
const PROBE_KEY = 'chairside.measure.probe'

// Printable ASCII, the whitelisted display symbols, then probes for glyphs the
// whitelist leaves out (recorded so the evidence shows why they are excluded).
const WHITELIST = ['●', '○', '■', '□', '▶', '▷', '━', '─', '│', '·']
const PROBES = ['→', '…', '✓', '—', '’', 'é', '€', '★']
const GLYPHS = [
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) =>
    String.fromCharCode(0x20 + i),
  ),
  ...WHITELIST,
  ...PROBES,
]

function pages(): string[][] {
  const perPage = ROWS_PER_PAGE - 1
  const result: string[][] = []
  for (let i = 0; i < GLYPHS.length; i += perPage)
    result.push(GLYPHS.slice(i, i + perPage))
  return result
}

function rows(glyphs: string[]): TextContainerProperty[] {
  const contents = ['||', ...glyphs.map((g) => `|${g.repeat(REPEAT)}|`)]
  return contents.map(
    (content, row) =>
      new TextContainerProperty({
        xPosition: 0,
        yPosition: row * ROW_PITCH,
        width: 576,
        height: ROW_PITCH,
        borderWidth: 0,
        paddingLength: 0,
        containerID: row + 1,
        containerName: `row${row}`,
        content,
        isEventCapture: row === 0 ? 1 : 0,
      }),
  )
}

const codes = (glyphs: string[]) =>
  glyphs.map((g) => g.codePointAt(0)!.toString(16)).join(',')

export async function showMeasure(bridge: EvenAppBridge): Promise<void> {
  const all = pages()
  let page = 0
  const stored = await bridge.getLocalStorage(PROBE_KEY).catch(() => '')
  console.log(`[chairside] measure storage=${stored ? 'kept' : 'empty'}`)
  const value = String(Date.now())
  const written = await bridge
    .setLocalStorage(PROBE_KEY, value)
    .catch(() => false)
  const readBack = await bridge.getLocalStorage(PROBE_KEY).catch(() => '')
  console.log(
    `[chairside] measure roundtrip=${written && readBack === value ? 'ok' : `failed(written=${written})`}`,
  )

  const show = async (index: number) => {
    const glyphs = all[index]!
    const textObject = rows(glyphs)
    const ok =
      index === 0
        ? (await bridge.createStartUpPageContainer(
            new CreateStartUpPageContainer({
              containerTotalNum: textObject.length,
              textObject,
            }),
          )) === StartUpPageCreateResult.success
        : await bridge.rebuildPageContainer(
            new RebuildPageContainer({
              containerTotalNum: textObject.length,
              textObject,
            }),
          )
    if (!ok) console.error(`[chairside] measure page=${index} failed`)
    else
      console.log(
        `[chairside] measure page=${index} rows=${codes(glyphs)} pitch=${ROW_PITCH} repeat=${REPEAT}`,
      )
  }

  bridge.onEvenHubEvent((event) => {
    const input = normalizeEvent(event)
    if (input?.kind !== 'click') return
    if (page + 1 >= all.length) {
      console.log('[chairside] measure done')
      return
    }
    page += 1
    void show(page)
  })
  console.log(`[chairside] measure pages=${all.length}`)
  await show(0)
  console.log('[chairside] ready')
}
