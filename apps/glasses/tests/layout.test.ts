import { describe, expect, it } from 'vitest'
import { GLYPH_WIDTHS } from '../src/ui/glyph-widths'
import {
  alignRight,
  clean,
  fitBlock,
  fitLine,
  header,
  isDisplayable,
  layoutKey,
  MARGIN,
  META_WIDTH,
  pageProblems,
  SAFETY_PX,
  sanitize,
  SCREEN_WIDTH,
  SYMBOLS,
  textWidth,
  wrap,
  type Page,
} from '../src/ui/layout'

const ASCII = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
  String.fromCharCode(0x20 + i),
)

describe('glyph whitelist sanitizer', () => {
  it('keeps printable ASCII and the confirmed display symbols', () => {
    const drawable = ASCII.filter((char) => char !== '`').join('') + SYMBOLS
    expect(sanitize(drawable)).toBe(drawable)
    expect(sanitize('● free (45 min) · ○ taken ■ □ ▶ ▷ ━ ─ │')).toBe(
      '● free (45 min) · ○ taken ■ □ ▶ ▷ ━ ─ │',
    )
  })

  it('drops the backtick, which the firmware font does not draw', () => {
    expect(GLYPH_WIDTHS['`']).toBeUndefined()
    expect(sanitize('a`b')).toBe("a'b")
  })

  it('maps typographic quotes, dashes, ellipses and arrows to ASCII', () => {
    expect(sanitize('Karim’s “best” cut – 3pm—4pm…')).toBe(
      'Karim\'s "best" cut - 3pm-4pm...',
    )
    expect(sanitize('Open Telegram → @bot')).toBe('Open Telegram -> @bot')
    expect(sanitize('• one')).toBe('· one')
  })

  it('strips accents and drops emoji, other scripts and control characters', () => {
    expect(sanitize('José Müller Ångström')).toBe('Jose Muller Angstrom')
    expect(sanitize('Anna 💈✂️')).toBe('Anna ')
    expect(sanitize('Омар عمر 李')).toBe('  ')
    expect(sanitize('a\u0000b​c')).toBe('abc')
    expect(sanitize('tab\there\nnew')).toBe('tab here new')
  })

  it('clean() also collapses spaces and trims, for server strings', () => {
    expect(clean('  Anna   💈  · Skin fade ')).toBe('Anna · Skin fade')
    expect(clean('Омар')).toBe('')
  })

  it('isDisplayable() accepts multi-line drawable text only', () => {
    expect(isDisplayable('Next\nThen ●')).toBe(true)
    expect(isDisplayable('Next ✓')).toBe(false)
    expect(isDisplayable('a`b')).toBe(false)
  })

  it('every drawable glyph has a width measured in the simulator', () => {
    for (const char of [...ASCII.filter((c) => c !== '`'), ...SYMBOLS])
      expect(
        GLYPH_WIDTHS[char],
        `width of ${JSON.stringify(char)}`,
      ).toBeGreaterThan(0)
  })
})

describe('text fitting', () => {
  it('measures with the simulator widths', () => {
    expect(textWidth('')).toBe(0)
    expect(textWidth('MM')).toBe(Math.ceil(2 * GLYPH_WIDTHS.M!))
    expect(textWidth('● 1')).toBe(
      Math.ceil(GLYPH_WIDTHS['●']! + GLYPH_WIDTHS[' ']! + GLYPH_WIDTHS['1']!),
    )
  })

  it('fitLine keeps a fitting line and cuts a long one with "..." inside the safety margin', () => {
    expect(fitLine('Book & reply', 552)).toBe('Book & reply')
    const long = 'W'.repeat(60)
    const cut = fitLine(long, 300)
    expect(cut.endsWith('...')).toBe(true)
    expect(textWidth(cut)).toBeLessThanOrEqual(300 - SAFETY_PX)
    expect(textWidth(`${cut.slice(0, -3)}W...`)).toBeGreaterThan(
      300 - SAFETY_PX,
    )
  })

  it('wrap breaks at spaces and splits words longer than a line', () => {
    const lines = wrap(
      'Sat 28 Nov · 15:00 · ● free (45 min) and a long tail',
      260,
    )
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines)
      expect(textWidth(line)).toBeLessThanOrEqual(260 - SAFETY_PX)
    expect(lines.join(' ')).toBe(
      'Sat 28 Nov · 15:00 · ● free (45 min) and a long tail',
    )
    const split = wrap('M'.repeat(40), 200)
    expect(split.join('')).toBe('M'.repeat(40))
    for (const line of split)
      expect(textWidth(line)).toBeLessThanOrEqual(200 - SAFETY_PX)
  })

  it('fitBlock never returns more than maxLines and marks a cut with "..."', () => {
    const lines = fitBlock(['A '.repeat(80), 'second', 'third'], 300, 3)
    expect(lines).toHaveLength(3)
    expect(lines[2]!.endsWith('...')).toBe(true)
    for (const line of lines)
      expect(textWidth(line)).toBeLessThanOrEqual(300 - SAFETY_PX)
    expect(fitBlock(['one', '', 'two'], 300, 3)).toEqual(['one', '', 'two'])
  })

  it('header right-aligns meta in a fixed box and keeps the title clear of it', () => {
    const [title, meta] = header('New request', 'TEST · 2/3')
    expect(title!.content).toBe('NEW REQUEST')
    expect(meta!.content.trimStart()).toBe('TEST · 2/3')
    expect(meta!.x + meta!.width).toBe(SCREEN_WIDTH - MARGIN)
    expect(meta!.width).toBe(META_WIDTH)
    expect(title!.x + title!.width).toBeLessThan(meta!.x)
    // The text ends within one space of the box's safe right edge.
    const end = textWidth(meta!.content)
    expect(end).toBeLessThanOrEqual(META_WIDTH - SAFETY_PX)
    expect(end).toBeGreaterThan(META_WIDTH - SAFETY_PX - 2 * GLYPH_WIDTHS[' ']!)
    const [long] = header('W'.repeat(50), 'TEST · 10/12')
    expect(textWidth(long!.content)).toBeLessThanOrEqual(long!.width)
  })

  it('header geometry does not depend on the meta text', () => {
    expect(
      layoutKey({ screen: 'card', boxes: header('A', 'TEST · 1/2') }),
    ).toBe(layoutKey({ screen: 'card', boxes: header('B', 'TEST · 12/12') }))
    expect(alignRight('x', 100).trimStart()).toBe('x')
  })
})

describe('page checks', () => {
  const ok: Page = {
    screen: 'root',
    boxes: [
      {
        kind: 'text',
        name: 'a',
        x: 0,
        y: 0,
        width: 576,
        height: 27,
        content: 'Hi',
      },
      {
        kind: 'list',
        name: 'b',
        x: 0,
        y: 40,
        width: 576,
        height: 80,
        items: ['One', 'Two'],
        capture: true,
      },
    ],
  }

  it('accepts a valid page', () => {
    expect(pageProblems(ok)).toEqual([])
  })

  it('reports overflow, capture, naming, glyph and bounds problems', () => {
    const bad: Page = {
      screen: 'root',
      boxes: [
        {
          kind: 'text',
          name: 'a-very-long-container-name',
          x: 500,
          y: 0,
          width: 100,
          height: 27,
          content: 'one\ntwo',
          capture: true,
        },
        {
          kind: 'text',
          name: 'b',
          x: 0,
          y: 0,
          width: 50,
          height: 27,
          content: 'WWWWWWW ✓',
        },
        {
          kind: 'list',
          name: 'b',
          x: 0,
          y: 100,
          width: 576,
          height: 40,
          items: ['One', 'Two'],
          capture: true,
        },
      ],
    }
    const problems = pageProblems(bad).join('\n')
    expect(problems).toMatch(/2 event-capture containers/)
    expect(problems).toMatch(/name must be 1-16 characters/)
    expect(problems).toMatch(/outside the 576x288 screen/)
    expect(problems).toMatch(/2 lines overflow the height/)
    expect(problems).toMatch(/line wider than the box/)
    expect(problems).toMatch(/undrawable glyphs/)
    expect(problems).toMatch(/duplicate name/)
    expect(problems).toMatch(/items overflow the height/)
  })

  it('layoutKey ignores text content but not list items or geometry', () => {
    const text = structuredClone(ok)
    ;(text.boxes[0] as { content: string }).content = 'Changed'
    expect(layoutKey(text)).toBe(layoutKey(ok))
    const items = structuredClone(ok)
    ;(items.boxes[1] as { items: string[] }).items = ['One', 'Three']
    expect(layoutKey(items)).not.toBe(layoutKey(ok))
    const moved = structuredClone(ok)
    moved.boxes[0]!.y = 1
    expect(layoutKey(moved)).not.toBe(layoutKey(ok))
  })
})
