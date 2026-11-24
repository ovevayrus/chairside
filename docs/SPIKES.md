# Spikes

Live checks that de-risk the build. Each section records what was run, when, and the ids involved. No message text, tokens or other secrets are ever written here.

## S1 Telegram

Pending: needs the bot token, the owner's Telegram Business connection and a consenting customer account. Run `npx tsx scripts/spike-telegram.ts` and follow the prompts; results are appended below.

## S2 Calendar

Pending: needs the service-account JSON and the shared calendar id. Run `npx tsx scripts/spike-calendar.ts`; results are appended below.

## S3 Simulator (automated run 2026-11-24T13:32:43.946Z)

Produced by `npm run e2e -- --smoke --spike` (`e2e/run.mjs`): backend on :8787, Vite on :5173, evenhub-simulator 0.9.5 with `--automation-port 9898`, SDK 0.0.16, Node v24.13.0 on win32. Simulator only: nothing in this section ran on G2 hardware. The runner rewrites this section on every run.

### Smoke, root page (`http://localhost:5173`): PASS (exit dialog not simulated, see below)

- Ready: `[chairside] ready` seen 1604 ms after the simulator was launched (automation API up after 191 ms; budget 10000 ms).
- Lit pixels at ready (alpha > 0): 927, required > 500. `docs/evidence/e2e-smoke-ready.png`
- Root `double_click`: the app logged `[chairside] exit dialog requested` and called `shutDownPageContainer(1)`. Pixels changed against the ready frame: 927, inside the box x 16..282, y 22..69 (267 x 48 px). Lit pixels inside that box: 927 at ready, 0 after the double-tap. `docs/evidence/e2e-smoke-double-tap.png`
- Exit dialog: not simulated. evenhub-simulator 0.9.5 shows no system dialog on the glasses display for `shutDownPageContainer(1)`: it removes the page, the display stays dark, and it logs `inject_input: no active event container` for every later input. The box above is therefore the root text being cleared, not a dialog.
- Dismiss gesture: none found in the simulator. Attempts in order: `double_click` -> 927 px differ from ready; `down + click` -> 927 px differ from ready; `up + click` -> 927 px differ from ready. Unverified here: the system dialog and its cancel gesture must be checked on G2 hardware. `docs/evidence/e2e-smoke-after-attempts.png`
- App console from the double-tap on: `[chairside] exit dialog requested`.
- Simulator log from the double-tap on: `ShutDownPageContainer`, `inject_input: no active event container` (x5).

### Spike, dev page (`http://localhost:5173/?spike=1`): PASS

- Ready: `[chairside] ready` and `[chairside] screen=spike` 612 ms after launch (automation API up after 182 ms).
- healthz: the WebView fetched `GET http://localhost:8787/healthz` cross-origin from `http://localhost:5173` and logged `[chairside] healthz ok status=200`; the runner's own request with `Origin: http://localhost:5173` got `Access-Control-Allow-Origin: *`.
- WebSocket: the WebView opened `ws://localhost:8787/ws` and sent a hello with a dev token; it logged `[chairside] ws hello ok` (the server answered `{"type":"hello.ok"}`).
- List (3 items, highlight starts on index 0): two `down` inputs changed 1473 and 1227 pixels (the highlight moved); app list events during the scrolls: none (the list scrolls inside the firmware). `docs/evidence/e2e-spike-list.png`, `docs/evidence/e2e-spike-down2.png`
- Click after the two downs: `[chairside] list index=2 event=click`, so the highlight had moved from index 0 to index 2 (expected 2).
- Long press: `long_press` -> `[chairside] long-press start`; `long_press_release` -> `[chairside] long-press release`.
