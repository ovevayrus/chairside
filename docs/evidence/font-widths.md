# Glasses font widths (simulator)

Measured 2026-11-24T18:56:24.124Z by `node e2e/measure-font.mjs` in evenhub-simulator 0.9.5 (simulator only, not G2 hardware). The dev page `?measure=1` draws a reference row `||` and one row `|` + glyph x 16 + `|` per glyph; advance = (row right edge - reference right edge) / 16. The table feeds `apps/glasses/src/ui/glyph-widths.ts`; the layout code keeps a safety margin because the hardware font may differ slightly. Page screenshots: `docs/evidence/font-measure-page*.png`.

- Whitelisted display symbols: ● ○ ■ □ ▶ ▷ ━ ─ │ ·. Every one drew lit pixels.
- ASCII glyphs the font does not draw (advance only, no pixels), so the app's sanitizer drops them: backtick.
- Bridge local storage: a value written on the first launch was read back as "ok" in the same session; after a simulator relaunch the first read was "empty" (first launch: "empty").

| Glyph | Code point | Advance px | Drawn |
| --- | --- | --- | --- |
| space | U+0020 | 5.13 | n/a |
| ! | U+0021 | 4 | yes |
| " | U+0022 | 6 | yes |
| # | U+0023 | 13.94 | yes |
| $ | U+0024 | 12.06 | yes |
| % | U+0025 | 14 | yes |
| & | U+0026 | 15 | yes |
| ' | U+0027 | 4 | yes |
| ( | U+0028 | 6.06 | yes |
| ) | U+0029 | 6.06 | yes |
| * | U+002A | 8 | yes |
| + | U+002B | 10 | yes |
| , | U+002C | 5 | yes |
| - | U+002D | 10 | yes |
| . | U+002E | 5 | yes |
| / | U+002F | 5.13 | yes |
| 0 | U+0030 | 12 | yes |
| 1 | U+0031 | 7 | yes |
| 2 | U+0032 | 11.06 | yes |
| 3 | U+0033 | 12 | yes |
| 4 | U+0034 | 11.94 | yes |
| 5 | U+0035 | 12 | yes |
| 6 | U+0036 | 12 | yes |
| 7 | U+0037 | 11.94 | yes |
| 8 | U+0038 | 12 | yes |
| 9 | U+0039 | 12 | yes |
| : | U+003A | 4 | yes |
| ; | U+003B | 5 | yes |
| < | U+003C | 10 | yes |
| = | U+003D | 10 | yes |
| > | U+003E | 10 | yes |
| ? | U+003F | 12 | yes |
| @ | U+0040 | 17 | yes |
| A | U+0041 | 12.94 | yes |
| B | U+0042 | 12 | yes |
| C | U+0043 | 11 | yes |
| D | U+0044 | 12 | yes |
| E | U+0045 | 10 | yes |
| F | U+0046 | 10 | yes |
| G | U+0047 | 12 | yes |
| H | U+0048 | 12 | yes |
| I | U+0049 | 5.06 | yes |
| J | U+004A | 8 | yes |
| K | U+004B | 12 | yes |
| L | U+004C | 9 | yes |
| M | U+004D | 16 | yes |
| N | U+004E | 12 | yes |
| O | U+004F | 12 | yes |
| P | U+0050 | 12 | yes |
| Q | U+0051 | 12 | yes |
| R | U+0052 | 12 | yes |
| S | U+0053 | 11.06 | yes |
| T | U+0054 | 10 | yes |
| U | U+0055 | 12 | yes |
| V | U+0056 | 12.94 | yes |
| W | U+0057 | 16 | yes |
| X | U+0058 | 13.06 | yes |
| Y | U+0059 | 12.94 | yes |
| Z | U+005A | 12.06 | yes |
| [ | U+005B | 7 | yes |
| \ | U+005C | 5.13 | yes |
| ] | U+005D | 7 | yes |
| ^ | U+005E | 10 | yes |
| _ | U+005F | 9 | yes |
| a | U+0061 | 10.94 | yes |
| b | U+0062 | 11 | yes |
| c | U+0063 | 10 | yes |
| d | U+0064 | 11 | yes |
| e | U+0065 | 10.06 | yes |
| f | U+0066 | 7.06 | yes |
| g | U+0067 | 11 | yes |
| h | U+0068 | 11 | yes |
| i | U+0069 | 4.94 | yes |
| j | U+006A | 4.94 | yes |
| k | U+006B | 9 | yes |
| l | U+006C | 4 | yes |
| m | U+006D | 16 | yes |
| n | U+006E | 11 | yes |
| o | U+006F | 10.06 | yes |
| p | U+0070 | 11 | yes |
| q | U+0071 | 11 | yes |
| r | U+0072 | 7 | yes |
| s | U+0073 | 9.94 | yes |
| t | U+0074 | 6 | yes |
| u | U+0075 | 11 | yes |
| v | U+0076 | 10.94 | yes |
| w | U+0077 | 14.94 | yes |
| x | U+0078 | 10.94 | yes |
| y | U+0079 | 10.94 | yes |
| z | U+007A | 8.94 | yes |
| { | U+007B | 8.06 | yes |
| \| | U+007C | 4 | yes |
| } | U+007D | 8.06 | yes |
| ~ | U+007E | 16 | yes |
| ● | U+25CF | 20 | yes |
| ○ | U+25CB | 20 | yes |
| ■ | U+25A0 | 20 | yes |
| □ | U+25A1 | 20 | yes |
| ▶ | U+25B6 | 20 | yes |
| ▷ | U+25B7 | 20 | yes |
| ━ | U+2501 | 20 | yes |
| ─ | U+2500 | 20 | yes |
| │ | U+2502 | 20 | yes |
| · | U+00B7 | 5 | yes |
| backtick | U+0060 | 4 | NO |

Probes outside the whitelist (recorded only; the app never sends them):

| Glyph | Code point | Advance px | Drawn |
| --- | --- | --- | --- |
| → | U+2192 | 17 | yes |
| … | U+2026 | 10 | yes |
| ✓ | U+2713 | 4 | NO |
| — | U+2014 | 15 | yes |
| ’ | U+2019 | 5 | yes |
| é | U+00E9 | 10.06 | yes |
| € | U+20AC | 15 | yes |
| ★ | U+2605 | 20 | yes |
