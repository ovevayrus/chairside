// Page model, text fitting and the glyph whitelist for the 576x288 display.
// Pure: no bridge calls here, so every rule is unit-tested (tests/layout.test.ts).
import { GLYPH_WIDTHS } from './glyph-widths'

export const SCREEN_WIDTH = 576
export const SCREEN_HEIGHT = 288
/** Firmware line height for text containers. */
export const LINE_HEIGHT = 27
/** Firmware list item height and the text inset on each side of an item. */
export const LIST_ITEM_HEIGHT = 40
export const LIST_ITEM_INSET = 12
/** Left/right page margin for text. */
export const MARGIN = 12
/**
 * Widths come from the simulator (docs/evidence/font-widths.md); hardware may
 * differ slightly, so every fitted line stays this many px short of its box.
 */
export const SAFETY_PX = 12
const ELLIPSIS = '...'
/** Firmware limits (SDK docs; the simulator enforces 999 bytes and 63-byte items). */
const MAX_TEXT_BYTES = 999
const MAX_ITEM_BYTES = 63
const MAX_ITEMS = 20
const MAX_NAME = 16

/**
 * Display symbols the firmware font draws, each confirmed in the simulator
 * (docs/evidence/font-widths.md). Everything else outside printable ASCII is
 * dropped, and so is the backtick, which the font does not draw.
 */
export const SYMBOLS = '●○■□▶▷━─│·'
const DROP = new RegExp(`[^\\x20-\\x5f\\x61-\\x7e${SYMBOLS}]`, 'gu')
const MAPPINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′´`]/gu, "'"],
  [/[“”„‟″]/gu, '"'],
  [/[‐-―−]/gu, '-'],
  [/…/gu, '...'],
  [/[→⇒➡]/gu, '->'],
  [/[•∙]/gu, '·'],
]

/**
 * Keeps only glyphs the glasses can draw. Typographic quotes, dashes and the
 * ellipsis become ASCII, accents are stripped (NFKD), and any other character
 * (emoji, unsupported scripts, control characters) is removed, because the
 * firmware would silently skip it. Whitespace becomes plain spaces.
 */
export function sanitize(text: string): string {
  let result = text
  for (const [pattern, replacement] of MAPPINGS)
    result = result.replace(pattern, replacement)
  return result.normalize('NFKD').replace(/\s/gu, ' ').replace(DROP, '')
}

/** sanitize(), then collapse runs of spaces and trim: for server-provided strings. */
export function clean(text: string): string {
  return sanitize(text).replace(/ {2,}/g, ' ').trim()
}

/** True when every character is drawable (newlines allowed). */
export function isDisplayable(text: string): boolean {
  return text.split('\n').every((line) => sanitize(line) === line)
}

/** Unknown glyphs are dropped by sanitize(); count them as the widest glyph. */
const FALLBACK_WIDTH = Math.max(...Object.values(GLYPH_WIDTHS))

/** Rendered width in px of one line (simulator font metrics, kerning ignored). */
export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += GLYPH_WIDTHS[char] ?? FALLBACK_WIDTH
  return Math.ceil(width)
}

function withEllipsis(text: string, limit: number): string {
  const chars = [...text.trimEnd()]
  while (chars.length > 0 && textWidth(chars.join('') + ELLIPSIS) > limit)
    chars.pop()
  return chars.join('').trimEnd() + ELLIPSIS
}

/** The line itself if it fits in `maxWidth` (minus the safety margin), else a cut ending in "...". */
export function fitLine(text: string, maxWidth: number): string {
  const limit = maxWidth - SAFETY_PX
  return textWidth(text) <= limit ? text : withEllipsis(text, limit)
}

/**
 * Word-wraps one paragraph so each line fits `maxWidth` minus the safety
 * margin; a word longer than a line is split. The firmware then never has to
 * wrap on its own, so the line count is known before the page is sent.
 */
export function wrap(text: string, maxWidth: number): string[] {
  const limit = maxWidth - SAFETY_PX
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ').filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (textWidth(candidate) <= limit) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    line = ''
    let rest = word
    while (textWidth(rest) > limit) {
      const chars = [...rest]
      let cut = chars.length - 1
      while (cut > 1 && textWidth(chars.slice(0, cut).join('')) > limit) cut--
      lines.push(chars.slice(0, cut).join(''))
      rest = chars.slice(cut).join('')
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Fits paragraphs into at most `maxLines` lines of `maxWidth`: each paragraph
 * is wrapped, and when the block is too long the last kept line ends in "...".
 */
export function fitBlock(
  paragraphs: readonly string[],
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines = paragraphs.flatMap((paragraph) =>
    paragraph === '' ? [''] : wrap(paragraph, maxWidth),
  )
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept.pop() ?? ''
  kept.push(withEllipsis(last, maxWidth - SAFETY_PX))
  return kept
}

/** Height a text box needs for `lines` lines with the given padding and border. */
export function textBoxHeight(lines: number, padding = 0, border = 0): number {
  return lines * LINE_HEIGHT + 2 * (padding + border)
}

export interface TextBox {
  kind: 'text'
  /** Unique per page, at most 16 characters. */
  name: string
  x: number
  y: number
  width: number
  height: number
  content: string
  /** Text brightness 0 (dim) to 4 (firmware default, brightest). */
  brightness?: number
  padding?: number
  border?: { width: number; color: number; radius: number }
  capture?: boolean
}

export interface ListBox {
  kind: 'list'
  name: string
  x: number
  y: number
  width: number
  height: number
  items: string[]
  capture?: boolean
}

export type Box = TextBox | ListBox

export type ScreenName = 'pair' | 'root' | 'card' | 'receipt' | 'status'

export interface Page {
  screen: ScreenName
  boxes: Box[]
}

/** Header brightness: dim, so the body reads first. */
export const DIM = 2
/** The firmware's default (and brightest) text level. */
export const BRIGHT = 4

/** Fixed width of the header's right-hand box, so its text updates in place. */
export const META_WIDTH = 200

/** Leading spaces that push `text` to the right edge of a `width`-px box. */
export function alignRight(text: string, width: number): string {
  const spare = width - SAFETY_PX - textWidth(text)
  const space = GLYPH_WIDTHS[' '] ?? 5
  return ' '.repeat(Math.max(0, Math.floor(spare / space))) + text
}

/**
 * A header row: `title` (upper case) on the left and `meta` (TEST, position,
 * date) right-aligned in a fixed box using the measured glyph widths. Both are
 * dim unless `bright` asks the title to stand out (an alert after a tap).
 */
export function header(
  title: string,
  meta: string,
  { bright = false }: { bright?: boolean } = {},
): TextBox[] {
  const metaX = SCREEN_WIDTH - MARGIN - META_WIDTH
  const titleWidth = metaX - MARGIN - 8
  const right = fitLine(clean(meta), META_WIDTH)
  return [
    {
      kind: 'text',
      name: 'title',
      x: MARGIN,
      y: 2,
      width: titleWidth,
      height: LINE_HEIGHT,
      content: fitLine(clean(title).toUpperCase(), titleWidth) || ' ',
      brightness: bright ? BRIGHT : DIM,
    },
    {
      kind: 'text',
      name: 'meta',
      x: metaX,
      y: 2,
      width: META_WIDTH,
      height: LINE_HEIGHT,
      content: right ? alignRight(right, META_WIDTH) : ' ',
      brightness: DIM,
    },
  ]
}

export const CONTENT_WIDTH = SCREEN_WIDTH - 2 * MARGIN

/** A dim hint line at the bottom of the screen. */
export function footer(text: string): TextBox {
  return {
    kind: 'text',
    name: 'footer',
    x: MARGIN,
    y: SCREEN_HEIGHT - LINE_HEIGHT - 4,
    width: CONTENT_WIDTH,
    height: LINE_HEIGHT,
    content: fitLine(clean(text), CONTENT_WIDTH) || ' ',
    brightness: DIM,
  }
}

/**
 * Plain text lines, each fitted to the box width (spacing inside a line is
 * kept); empty lines stay as spacers.
 */
export function textLines(
  name: string,
  lines: readonly string[],
  geometry: { x: number; y: number; width: number },
  options: { brightness?: number; capture?: boolean } = {},
): TextBox {
  const fitted = lines.map((line) =>
    fitLine(sanitize(line).trim(), geometry.width),
  )
  return {
    kind: 'text',
    name,
    ...geometry,
    height: textBoxHeight(Math.max(fitted.length, 1)),
    content: fitted.map((line) => line || ' ').join('\n') || ' ',
    ...options,
  }
}

export const PANEL_PADDING = 8
export const PANEL_BORDER = { width: 2, color: 8, radius: 8 }
const PANEL_INSET = PANEL_PADDING + PANEL_BORDER.width

/**
 * A rounded, bordered box holding exactly `lines` lines (shorter content is
 * padded, so its size never changes and updates stay flicker-free).
 */
export function panel(
  name: string,
  paragraphs: readonly string[],
  geometry: { x: number; y: number; width: number; lines: number },
  options: { capture?: boolean; center?: boolean } = {},
): TextBox {
  const innerWidth = geometry.width - 2 * PANEL_INSET
  const lines = fitBlock(
    paragraphs.map((paragraph) => clean(paragraph)),
    innerWidth,
    geometry.lines,
  )
  const centered = options.center
    ? lines.map((line) => {
        const spare = innerWidth - SAFETY_PX - textWidth(line)
        const spaces = Math.max(
          0,
          Math.floor(spare / 2 / (GLYPH_WIDTHS[' '] ?? 5)),
        )
        return ' '.repeat(spaces) + line
      })
    : lines
  while (centered.length < geometry.lines) centered.push(' ')
  return {
    kind: 'text',
    name,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: textBoxHeight(geometry.lines, PANEL_PADDING, PANEL_BORDER.width),
    content: centered.map((line) => line || ' ').join('\n'),
    padding: PANEL_PADDING,
    border: PANEL_BORDER,
    capture: options.capture,
  }
}

const utf8 = new TextEncoder()

/** Every page rule the firmware or SDK would reject or render badly. */
export function pageProblems(page: Page): string[] {
  const problems: string[] = []
  const names = new Set<string>()
  if (page.boxes.length === 0) problems.push('no containers')
  if (page.boxes.length > 8) problems.push('more than 8 text/list containers')
  const captures = page.boxes.filter((box) => box.capture).length
  if (captures !== 1) problems.push(`${captures} event-capture containers`)
  for (const box of page.boxes) {
    const where = `${box.kind} "${box.name}"`
    if (!box.name || box.name.length > MAX_NAME)
      problems.push(`${where}: name must be 1-16 characters`)
    if (names.has(box.name)) problems.push(`${where}: duplicate name`)
    names.add(box.name)
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.x + box.width > SCREEN_WIDTH ||
      box.y + box.height > SCREEN_HEIGHT
    )
      problems.push(`${where}: outside the 576x288 screen`)
    if (box.kind === 'text') {
      const inset = (box.padding ?? 0) + (box.border?.width ?? 0)
      const lines = box.content.split('\n')
      if (!box.content) problems.push(`${where}: empty content`)
      if (utf8.encode(box.content).length > MAX_TEXT_BYTES)
        problems.push(`${where}: content over ${MAX_TEXT_BYTES} bytes`)
      if (!isDisplayable(box.content))
        problems.push(`${where}: undrawable glyphs`)
      if (textBoxHeight(lines.length, inset) > box.height)
        problems.push(`${where}: ${lines.length} lines overflow the height`)
      for (const line of lines) {
        if (textWidth(line) > box.width - 2 * inset)
          problems.push(`${where}: line wider than the box`)
      }
      if (
        box.brightness !== undefined &&
        (!Number.isInteger(box.brightness) ||
          box.brightness < 0 ||
          box.brightness > 4)
      )
        problems.push(`${where}: brightness outside 0-4`)
    } else {
      if (box.items.length === 0 || box.items.length > MAX_ITEMS)
        problems.push(`${where}: 1-${MAX_ITEMS} items`)
      if (box.items.length * LIST_ITEM_HEIGHT > box.height)
        problems.push(`${where}: items overflow the height`)
      for (const item of box.items) {
        if (!item || utf8.encode(item).length > MAX_ITEM_BYTES)
          problems.push(`${where}: item must be 1-${MAX_ITEM_BYTES} bytes`)
        if (!isDisplayable(item)) problems.push(`${where}: undrawable glyphs`)
        if (textWidth(item) > box.width - 2 * LIST_ITEM_INSET)
          problems.push(`${where}: item wider than the list`)
      }
    }
  }
  return problems
}

/** Everything about a page except text contents: equal keys mean text-only changes. */
export function layoutKey(page: Page): string {
  return JSON.stringify(
    page.boxes.map((box) =>
      box.kind === 'text' ? { ...box, content: undefined } : box,
    ),
  )
}
