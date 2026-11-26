# Simulator e2e: full run (US-011, US-018, US-019)

Run 2026-11-26T19:04:58.936Z by `npm run e2e` (`e2e/run.mjs`): backend in TEST MODE (`DEV_INJECT=1`, fake Telegram, fake calendar, fresh temp database), Vite dev server, evenhub-simulator 0.9.5 with `--automation-port 9898`, SDK 0.0.16, Node v24.13.0 on win32. Simulator only: nothing here ran on G2 hardware or against real Telegram or Google.

Result: **PASS**

## Steps

01. **pair**: first run shows the pairing steps and a 6-character code. 4135 lit px. ![pair](e2e-full-01-pair.png)
02. **root**: paired in 1733 ms; root shows Next/Then and no requests. 5793 lit px. ![root](e2e-full-02-root.png)
03. **root-tap-feedback**: tap on root with nothing waiting shows feedback. 5910 lit px. ![root-tap-feedback](e2e-full-03-root-tap-feedback.png)
04. **menu**: the system contextual menu shows Refresh and Pause cards 30 min. 3622 lit px. ![menu](e2e-full-04-menu.png)
05. **paused**: Pause cards 30 min: root says cards are paused. 6080 lit px. ![paused](e2e-full-05-paused.png)
06. **card**: DM to card in 2681 ms (2.5 s debounce included); smart default highlighted. 3977 lit px. ![card](e2e-full-06-card.png)
07. **receipt**: tap to receipt in 168 ms. 4517 lit px. ![receipt](e2e-full-07-receipt.png)
08. **root-after-booking**: the receipt advanced to root by itself after 2 s. 5793 lit px. ![root-after-booking](e2e-full-08-root-after-booking.png)
09. **card-before-block**: the 17:00 card shows the slot free. 3990 lit px. ![card-before-block](e2e-full-09-card-before-block.png)
10. **slot-taken**: slot_taken card: header says nothing was sent, first action offers the next opening. 4605 lit px. ![slot-taken](e2e-full-10-slot-taken.png)
11. **root-pending**: double-tap on the card went back to root; 1 request waiting. 6165 lit px. ![root-pending](e2e-full-11-root-pending.png)
12. **status**: backend stopped: status screen after 1093 ms. 4743 lit px. ![status](e2e-full-12-status.png)
13. **root-reconnected**: backend back: root again after 320 ms ([chairside] link=live). 5669 lit px. ![root-reconnected](e2e-full-13-root-reconnected.png)
14. **exit**: root double-tap: shutDownPageContainer(1) requested. 0 lit px. ![exit](e2e-full-14-exit.png)

## Move and cancel (after step 08)

15. **move-card**: WANTS TO MOVE shows 15:00 ▶ 16:00 as free with Move & reply highlighted. 3655 lit px. ![move-card](e2e-full-15-move-card.png)
16. **move-receipt**: the move receipt confirms Saturday 28 Nov at 16:00. 4540 lit px. ![move-receipt](e2e-full-16-move-receipt.png)
17. **cancel-card**: WANTS TO CANCEL shows the moved 16:00 booking with Cancel & reply highlighted. 3063 lit px. ![cancel-card](e2e-full-17-cancel-card.png)
18. **cancel-receipt**: the cancellation receipt confirms Saturday 28 Nov at 16:00. 4562 lit px. ![cancel-receipt](e2e-full-18-cancel-receipt.png)

## Checks

- [x] [chairside] ready within 10 s (970 ms)
- [x] e2e-full-01-pair.png has more than 500 lit pixels (got 4135)
- [x] /dev/pair bound the code on screen
- [x] e2e-full-02-root.png has more than 500 lit pixels (got 5793)
- [x] e2e-full-03-root-tap-feedback.png has more than 500 lit pixels (got 5910)
- [x] e2e-full-05-paused.png has more than 500 lit pixels (got 6080)
- [x] every rebuild carries the menu: after pausing it reads "Resume cards"
- [x] e2e-full-06-card.png has more than 500 lit pixels (got 3977)
- [x] booking answered ok ([chairside] action result req=13d8fece-6b82-465c-9f8a-04c0f85d65dc status=ok)
- [x] e2e-full-07-receipt.png has more than 500 lit pixels (got 4517)
- [x] the tap made exactly 1 fake Telegram send (got 1)
- [x] the tap made exactly 1 fake calendar event (got 1)
- [x] the event is "Chairside · Alex · Skin fade" at 2026-11-28T11:00:00.000Z (got Chairside · Alex · Skin fade at 2026-11-28T11:00:00.000Z)
- [x] e2e-full-08-root-after-booking.png has more than 500 lit pixels (got 5793)
- [x] e2e-full-15-move-card.png has more than 500 lit pixels (got 3655)
- [x] move answered ok ([chairside] action result req=70d685a0-a923-4cc3-afa0-9edfbb39be1f status=ok)
- [x] e2e-full-16-move-receipt.png has more than 500 lit pixels (got 4540)
- [x] move made exactly 1 successful fake Telegram send to Alex (got 1 sends)
- [x] move replaced the 15:00 event with one at 16:00 on the same day and kept its duration
- [x] e2e-full-17-cancel-card.png has more than 500 lit pixels (got 3063)
- [x] cancel answered ok ([chairside] action result req=1906c78a-7ad6-4ae0-95e6-2636d344547e status=ok)
- [x] e2e-full-18-cancel-receipt.png has more than 500 lit pixels (got 4562)
- [x] cancel made exactly 1 successful fake Telegram send to Alex (got 1 sends)
- [x] cancel removed the 16:00 event
- [x] e2e-full-09-card-before-block.png has more than 500 lit pixels (got 3990)
- [x] the tap answered slot_taken ([chairside] action result req=3c4fc995-59e7-42ee-9c37-a7f90ed62ebf status=slot_taken)
- [x] e2e-full-10-slot-taken.png has more than 500 lit pixels (got 4605)
- [x] the stale tap made 0 fake sends (got 0)
- [x] the stale tap made 0 fake events (got 0)
- [x] e2e-full-11-root-pending.png has more than 500 lit pixels (got 6165)
- [x] e2e-full-12-status.png has more than 500 lit pixels (got 4743)
- [x] the restart did not ask to pair again
- [x] e2e-full-13-root-reconnected.png has more than 500 lit pixels (got 5669)
- [x] after the exit request the simulator either draws a dialog or has removed the page (0.9.5 draws none)

## Details

- Root appointments seeded for the screenshot: Sami, Yusuf.
- Clocks: Next/Then and card times are shop-local (Asia/Dubai, from the server); the header date and the "paused until" time are device-local. This machine runs at UTC-5, so they differ here; on a phone in the shop they agree.
- Contextual menu: `context_menu` opened the system menu with the page's items; `down` + `click` chose "Pause cards 30 min" and the next rebuild carried the menu as "Resume cards"; choosing it again resumed cards (the rebuild carried "Pause cards 30 min" again). App lines while resuming: `[chairside] lifecycle foreground_exit`, `[chairside] lifecycle foreground_enter`, `[chairside] link=connecting`, `[chairside] link=live`, `[chairside] state seq=3`, `[chairside] root drawn seq=3`, `[chairside] menu item=2`.
- Booking: request `13d8fece-6b82-465c-9f8a-04c0f85d65dc`, action `ac2d1ad76eb341529cf0b058b995c28c`; fake calendar event `9tr43suh68j4chsu0agqdc71mf` "Chairside · Alex · Skin fade" 2026-11-28T11:00:00.000Z to 2026-11-28T11:45:00.000Z; fake Telegram `sendText` to chat 605036125, message 1 (the fake keeps only a SHA-256 of the text).
- Timings: pair 1733 ms; DM to card 2681 ms (includes the 2.5 s debounce); tap to answer 168 ms.
- Stale slot: request `3c4fc995-59e7-42ee-9c37-a7f90ed62ebf`; a 30-minute foreign block inserted at 2026-11-28T13:00:00.000Z while the card was on screen; the tap answered `slot_taken` with card version 2; fake sends and events unchanged.
- Reconnect: status screen 1093 ms after the backend stopped; root again 320 ms after it restarted (same database and pepper), without re-pairing. App lines: `[chairside] link=live`.
- Exit: the app logged `[chairside] exit dialog requested` and called `shutDownPageContainer(1)`. Lit pixels 5669 before, 0 after (changed box x 12..563, y 8..283). Simulator log: `ShutDownPageContainer`, `inject_input: no active event container`. evenhub-simulator 0.9.5 draws no system exit dialog: it removes the page and ignores later input (docs/SPIKES.md S3), so the dialog and its cancel gesture need G2 hardware.
