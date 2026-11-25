# Simulator e2e: full run (US-011)

Run 2026-11-25T19:46:00.578Z by `npm run e2e` (`e2e/run.mjs`): backend in TEST MODE (`DEV_INJECT=1`, fake Telegram, fake calendar, fresh temp database), Vite dev server, evenhub-simulator 0.9.5 with `--automation-port 9898`, SDK 0.0.16, Node v24.13.0 on win32. Simulator only: nothing here ran on G2 hardware or against real Telegram or Google.

Result: **PASS**

## Steps

01. **pair**: first run shows the pairing steps and a 6-character code. 4157 lit px. ![pair](e2e-full-01-pair.png)
02. **root**: paired in 1620 ms; root shows Next/Then and no requests. 5348 lit px. ![root](e2e-full-02-root.png)
03. **root-tap-feedback**: tap on root with nothing waiting shows feedback. 5465 lit px. ![root-tap-feedback](e2e-full-03-root-tap-feedback.png)
04. **menu**: the system contextual menu shows Refresh and Pause cards 30 min. 3600 lit px. ![menu](e2e-full-04-menu.png)
05. **paused**: Pause cards 30 min: root says cards are paused. 5627 lit px. ![paused](e2e-full-05-paused.png)
06. **card**: DM to card in 2710 ms (2.5 s debounce included); smart default highlighted. 3992 lit px. ![card](e2e-full-06-card.png)
07. **receipt**: tap to receipt in 171 ms. 4532 lit px. ![receipt](e2e-full-07-receipt.png)
08. **root-after-booking**: the receipt advanced to root by itself after 2 s. 5348 lit px. ![root-after-booking](e2e-full-08-root-after-booking.png)
09. **card-before-block**: the 17:00 card shows the slot free. 3990 lit px. ![card-before-block](e2e-full-09-card-before-block.png)
10. **slot-taken**: slot_taken card: header says nothing was sent, first action offers the next opening. 4605 lit px. ![slot-taken](e2e-full-10-slot-taken.png)
11. **root-pending**: double-tap on the card went back to root; 1 request waiting. 5720 lit px. ![root-pending](e2e-full-11-root-pending.png)
12. **status**: backend stopped: status screen after 1108 ms. 4743 lit px. ![status](e2e-full-12-status.png)
13. **root-reconnected**: backend back: root again after 156 ms ([chairside] link=live). 5720 lit px. ![root-reconnected](e2e-full-13-root-reconnected.png)
14. **exit**: root double-tap: shutDownPageContainer(1) requested. 0 lit px. ![exit](e2e-full-14-exit.png)

## Checks

- [x] [chairside] ready within 10 s (1166 ms)
- [x] e2e-full-01-pair.png has more than 500 lit pixels (got 4157)
- [x] /dev/pair bound the code on screen
- [x] e2e-full-02-root.png has more than 500 lit pixels (got 5348)
- [x] e2e-full-03-root-tap-feedback.png has more than 500 lit pixels (got 5465)
- [x] e2e-full-05-paused.png has more than 500 lit pixels (got 5627)
- [x] every rebuild carries the menu: after pausing it reads "Resume cards"
- [x] e2e-full-06-card.png has more than 500 lit pixels (got 3992)
- [x] booking answered ok ([chairside] action result req=e1f01e9b-7880-4f83-a042-92c6bfb8acae status=ok)
- [x] e2e-full-07-receipt.png has more than 500 lit pixels (got 4532)
- [x] the tap made exactly 1 fake Telegram send (got 1)
- [x] the tap made exactly 1 fake calendar event (got 1)
- [x] the event is "Chairside · Anna · Skin fade" at 2026-11-28T11:00:00.000Z (got Chairside · Anna · Skin fade at 2026-11-28T11:00:00.000Z)
- [x] e2e-full-08-root-after-booking.png has more than 500 lit pixels (got 5348)
- [x] e2e-full-09-card-before-block.png has more than 500 lit pixels (got 3990)
- [x] the tap answered slot_taken ([chairside] action result req=5bbd0c2e-52b7-487b-b9ea-e571cc3c784f status=slot_taken)
- [x] e2e-full-10-slot-taken.png has more than 500 lit pixels (got 4605)
- [x] the stale tap made 0 fake sends (got 0)
- [x] the stale tap made 0 fake events (got 0)
- [x] e2e-full-11-root-pending.png has more than 500 lit pixels (got 5720)
- [x] e2e-full-12-status.png has more than 500 lit pixels (got 4743)
- [x] the restart did not ask to pair again
- [x] e2e-full-13-root-reconnected.png has more than 500 lit pixels (got 5720)
- [x] after the exit request the simulator either draws a dialog or has removed the page (0.9.5 draws none)

## Details

- Root appointments seeded for the screenshot: none (too close to midnight in the shop time zone).
- Clocks: Next/Then and card times are shop-local (Asia/Dubai, from the server); the header date and the "paused until" time are device-local. This machine runs at UTC-5, so they differ here; on a phone in the shop they agree.
- Contextual menu: `context_menu` opened the system menu with the page's items; `down` + `click` chose "Pause cards 30 min" and the next rebuild carried the menu as "Resume cards"; choosing it again resumed cards (the rebuild carried "Pause cards 30 min" again). App lines while resuming: `[chairside] lifecycle foreground_exit`, `[chairside] lifecycle foreground_enter`, `[chairside] link=connecting`, `[chairside] link=live`, `[chairside] menu item=2`.
- Booking: request `e1f01e9b-7880-4f83-a042-92c6bfb8acae`, action `3ad4d2f2f2fc4da0a9f4c8d7accb349f`; fake calendar event `651anp5k2a9faojqqag43slid8` "Chairside · Anna · Skin fade" 2026-11-28T11:00:00.000Z to 2026-11-28T11:45:00.000Z; fake Telegram `sendText` to chat 645804757, message 1 (the fake keeps only a SHA-256 of the text).
- Timings: pair 1620 ms; DM to card 2710 ms (includes the 2.5 s debounce); tap to answer 171 ms.
- Stale slot: request `5bbd0c2e-52b7-487b-b9ea-e571cc3c784f`; a 30-minute foreign block inserted at 2026-11-28T13:00:00.000Z while the card was on screen; the tap answered `slot_taken` with card version 2; fake sends and events unchanged.
- Reconnect: status screen 1108 ms after the backend stopped; root again 156 ms after it restarted (same database and pepper), without re-pairing. App lines: `[chairside] link=live`.
- Exit: the app logged `[chairside] exit dialog requested` and called `shutDownPageContainer(1)`. Lit pixels 5720 before, 0 after (changed box x 12..563, y 8..283). Simulator log: `ShutDownPageContainer`, `inject_input: no active event container`. evenhub-simulator 0.9.5 draws no system exit dialog: it removes the page and ignores later input (docs/SPIKES.md S3), so the dialog and its cancel gesture need G2 hardware.
