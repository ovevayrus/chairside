# Simulator e2e: full run (US-011, US-018, US-019, US-020)

Run 2026-11-26T19:20:38.028Z by `npm run e2e` (`e2e/run.mjs`): backend in TEST MODE (`DEV_INJECT=1`, fake Telegram, fake calendar, fresh temp database), Vite dev server, evenhub-simulator 0.9.5 with `--automation-port 9898`, SDK 0.0.16, Node v24.13.0 on win32. Simulator only: nothing here ran on G2 hardware or against real Telegram or Google.

Result: **PASS**

## Steps

01. **pair**: first run shows the pairing steps and a 6-character code. 4182 lit px. ![pair](e2e-full-01-pair.png)
02. **root**: paired in 1729 ms; root shows Next/Then and no requests. 5774 lit px. ![root](e2e-full-02-root.png)
03. **root-tap-feedback**: tap on root with nothing waiting shows feedback. 5891 lit px. ![root-tap-feedback](e2e-full-03-root-tap-feedback.png)
04. **menu**: the system contextual menu shows Refresh and Pause cards 30 min. 3619 lit px. ![menu](e2e-full-04-menu.png)
05. **paused**: Pause cards 30 min: root says cards are paused. 6064 lit px. ![paused](e2e-full-05-paused.png)
06. **card**: DM to card in 2660 ms (2.5 s debounce included); smart default highlighted. 3977 lit px. ![card](e2e-full-06-card.png)
07. **receipt**: tap to receipt in 161 ms. 4517 lit px. ![receipt](e2e-full-07-receipt.png)
08. **root-after-booking**: the receipt advanced to root by itself after 2 s. 5723 lit px. ![root-after-booking](e2e-full-08-root-after-booking.png)
09. **card-before-block**: the 17:00 card shows the slot free. 3990 lit px. ![card-before-block](e2e-full-09-card-before-block.png)
10. **slot-taken**: slot_taken card: header says nothing was sent, first action offers the next opening. 4620 lit px. ![slot-taken](e2e-full-10-slot-taken.png)
11. **root-pending**: double-tap on the card went back to root; 1 request waiting. 5884 lit px. ![root-pending](e2e-full-11-root-pending.png)
12. **status**: backend stopped: status screen after 1095 ms. 4743 lit px. ![status](e2e-full-12-status.png)
13. **root-reconnected**: backend back: root again after 320 ms ([chairside] link=live). 5669 lit px. ![root-reconnected](e2e-full-13-root-reconnected.png)
14. **exit**: root double-tap: shutDownPageContainer(1) requested. 0 lit px. ![exit](e2e-full-14-exit.png)

## Move and cancel (after step 08)

15. **move-card**: WANTS TO MOVE shows 15:00 ▶ 16:00 as free with Move & reply highlighted. 3655 lit px. ![move-card](e2e-full-15-move-card.png)
16. **move-receipt**: the move receipt confirms Saturday 28 Nov at 16:00. 4540 lit px. ![move-receipt](e2e-full-16-move-receipt.png)
17. **cancel-card**: WANTS TO CANCEL shows the shifted 16:15 booking with Cancel & reply highlighted. 3051 lit px. ![cancel-card](e2e-full-17-cancel-card.png)
18. **cancel-receipt**: the cancellation receipt confirms Saturday 28 Nov at 16:15. 4550 lit px. ![cancel-receipt](e2e-full-18-cancel-receipt.png)

## Running late (after step 16)

19. **late-card**: RUNNING LATE shows the 16:15 start and that it fits before Yusuf at 18:00. 4110 lit px. ![late-card](e2e-full-19-late-card.png)
20. **late-receipt**: the late shift receipt says “Shifted to 16:15”. 4434 lit px. ![late-receipt](e2e-full-20-late-receipt.png)

## Checks

- [x] [chairside] ready within 10 s (715 ms)
- [x] e2e-full-01-pair.png has more than 500 lit pixels (got 4182)
- [x] /dev/pair bound the code on screen
- [x] e2e-full-02-root.png has more than 500 lit pixels (got 5774)
- [x] e2e-full-03-root-tap-feedback.png has more than 500 lit pixels (got 5891)
- [x] e2e-full-05-paused.png has more than 500 lit pixels (got 6064)
- [x] every rebuild carries the menu: after pausing it reads "Resume cards"
- [x] e2e-full-06-card.png has more than 500 lit pixels (got 3977)
- [x] booking answered ok ([chairside] action result req=8914e13a-ca4d-4b53-be89-29ab7f139d61 status=ok)
- [x] e2e-full-07-receipt.png has more than 500 lit pixels (got 4517)
- [x] the tap made exactly 1 fake Telegram send (got 1)
- [x] the tap made exactly 1 fake calendar event (got 1)
- [x] the event is "Chairside · Alex · Skin fade" at 2026-11-28T11:00:00.000Z (got Chairside · Alex · Skin fade at 2026-11-28T11:00:00.000Z)
- [x] e2e-full-08-root-after-booking.png has more than 500 lit pixels (got 5723)
- [x] e2e-full-15-move-card.png has more than 500 lit pixels (got 3655)
- [x] move answered ok ([chairside] action result req=0fc85d31-e8fc-44c0-88fd-61f82715e68c status=ok)
- [x] e2e-full-16-move-receipt.png has more than 500 lit pixels (got 4540)
- [x] move made exactly 1 successful fake Telegram send to Alex (got 1 sends)
- [x] move replaced the 15:00 event with one at 16:00 on the same day and kept its duration
- [x] e2e-full-19-late-card.png has more than 500 lit pixels (got 4110)
- [x] late answered ok ([chairside] action result req=9710f63d-024d-44ba-bd05-d9526a03c792 status=ok)
- [x] e2e-full-20-late-receipt.png has more than 500 lit pixels (got 4434)
- [x] late shift made exactly 1 successful fake Telegram send to Alex (got 1 sends)
- [x] late shift replaced the 16:00 event with one at 16:15 and kept its duration
- [x] e2e-full-17-cancel-card.png has more than 500 lit pixels (got 3051)
- [x] cancel answered ok ([chairside] action result req=6e708f43-2eb9-4a5c-911b-6e634de98608 status=ok)
- [x] e2e-full-18-cancel-receipt.png has more than 500 lit pixels (got 4550)
- [x] cancel made exactly 1 successful fake Telegram send to Alex (got 1 sends)
- [x] cancel removed the 16:15 event
- [x] e2e-full-09-card-before-block.png has more than 500 lit pixels (got 3990)
- [x] the tap answered slot_taken ([chairside] action result req=6359bb6b-10ca-432a-afa7-3cc0dc711275 status=slot_taken)
- [x] e2e-full-10-slot-taken.png has more than 500 lit pixels (got 4620)
- [x] the stale tap made 0 fake sends (got 0)
- [x] the stale tap made 0 fake events (got 0)
- [x] e2e-full-11-root-pending.png has more than 500 lit pixels (got 5884)
- [x] e2e-full-12-status.png has more than 500 lit pixels (got 4743)
- [x] the restart did not ask to pair again
- [x] e2e-full-13-root-reconnected.png has more than 500 lit pixels (got 5669)
- [x] after the exit request the simulator either draws a dialog or has removed the page (0.9.5 draws none)

## Details

- Root appointments seeded for the screenshot: Sami, Yusuf.
- Simulated shop clock: 2026-11-28T06:00:00.000Z (10:00 Saturday in Asia/Dubai). Booking and message times use this clock throughout the run.
- Clocks: Next/Then and card times are shop-local (Asia/Dubai, from the server); the header date and the "paused until" time are device-local. This machine runs at UTC-5, so they differ here; on a phone in the shop they agree.
- Contextual menu: `context_menu` opened the system menu with the page's items; `down` + `click` chose "Pause cards 30 min" and the next rebuild carried the menu as "Resume cards"; choosing it again resumed cards (the rebuild carried "Pause cards 30 min" again). App lines while resuming: `[chairside] lifecycle foreground_exit`, `[chairside] lifecycle foreground_enter`, `[chairside] link=connecting`, `[chairside] link=live`, `[chairside] state seq=3`, `[chairside] root drawn seq=3`, `[chairside] menu item=2`.
- Booking: request `8914e13a-ca4d-4b53-be89-29ab7f139d61`, action `d67f9e32ed4347dc86f5e511f3dcf4c7`; fake calendar event `icgnds6q0um215e3s1n50hla1c` "Chairside · Alex · Skin fade" 2026-11-28T11:00:00.000Z to 2026-11-28T11:45:00.000Z; fake Telegram `sendText` to chat 605036125, message 1 (the fake keeps only a SHA-256 of the text).
- Timings: pair 1729 ms; DM to card 2660 ms (includes the 2.5 s debounce); tap to answer 161 ms.
- Stale slot: request `6359bb6b-10ca-432a-afa7-3cc0dc711275`; a 30-minute foreign block inserted at 2026-11-28T13:00:00.000Z while the card was on screen; the tap answered `slot_taken` with card version 2; fake sends and events unchanged.
- Reconnect: status screen 1095 ms after the backend stopped; root again 320 ms after it restarted (same database and pepper), without re-pairing. App lines: `[chairside] link=live`.
- Exit: the app logged `[chairside] exit dialog requested` and called `shutDownPageContainer(1)`. Lit pixels 5669 before, 0 after (changed box x 12..563, y 8..283). Simulator log: `ShutDownPageContainer`, `inject_input: no active event container`. evenhub-simulator 0.9.5 draws no system exit dialog: it removes the page and ignores later input (docs/SPIKES.md S3), so the dialog and its cancel gesture need G2 hardware.
