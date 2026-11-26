# Live smoke checklist (US-015)

The live end-to-end run with real Telegram and real Google Calendar. Run it with `npm run smoke:live`: the runner starts the server, Vite and the simulator, taps the glasses and inserts the Moment 3 calendar block itself. The people only send Telegram messages, which the runner prints word for word on lines starting `[smoke] >>>`. Before every tap it checks that the card is the expected request and that the highlighted action is the expected one, so it never acts on someone else's message.

A passing run writes everything marked **Record** below to `docs/evidence/live-smoke.md` (plus `live-smoke.json` and `live-smoke-*.png`). A failed run leaves that evidence alone and writes its report to `docs/evidence/live-smoke-run/`, which git ignores. The runner records ids, times, counts and statuses, never message text, names or Telegram user and chat ids. The screenshots are public, so it stops unless the customer accounts are named Alex or James.

```sh
npm run smoke:live                        # booking day: the first Saturday at least 2 days ahead
npm run smoke:live -- --day 2026-12-05    # another day; it must be free 14:00-18:30
npm run smoke:live -- --pause 3           # seconds each card stays up before the tap
npm run smoke:live -- --no-final-dm       # skip the DM after the reconnect
npm run smoke:live -- --keep-demo         # keep the seeded events and the block afterwards
```

`SHOP_CONFIG_PATH` (relative to `apps/server`, set in the shell or `.env`) picks the shop, for example `../../config/shop.recording.json`. The steps below are what the runner does, and the checklist for doing it by hand. Example date: Saturday 5 Dec 2026; all times are shop-local.

## A. Prerequisites

1. `apps/server/.env` is filled in (Telegram bot token, owner user id, Google service-account path and calendar id, device token pepper) and `DEV_INJECT` is not `1`. Never paste keys into chat.
2. The Even Hub simulator is installed, and ports 8787, 5173 and 9898 are free.
3. Telegram Desktop is logged in as the customer accounts, with Telegram first names Alex and James (Alex writes twice). In Business mode they message the owner's account, not the bot. Put their Telegram user ids (from @userinfobot) in `SMOKE_CUSTOMER_IDS` in `apps/server/.env`, comma-separated: the runner acts only on cards from those chats.
3a. During the run, the terminal asks for two counts in Moment 3 (messages below Alex's beard-trim question, before and after the tap), and James's "yes" must be typed, not pressed as the Book button.
4. Google Calendar is open in week view on the week of Sat 5 Dec 2026, showing the shop calendar. Today the shop calendar holds only demo events: the glasses' root screen shows today's next bookings, and its screenshots are public.
5. Screen layout: simulator left, Telegram Desktop top right, Google Calendar bottom right.
6. By hand: start `npm run start:server`, `npm run start:glasses` and `npm run start:simulator` from the repository root. **Record:** start time, server log line showing it is listening.

## B. Clean start

7. Run `npm run demo:reset`. It prints one line per removed event and `removed N demo event(s)`. **Record:** the output.
8. Run `npm run demo:seed`. It prints two lines: Sami 14:00-14:45 Haircut and Yusuf 16:15-16:35 Beard trim, today in shop time. **Record:** both event ids and the local times.
9. Refresh Google Calendar. Confirm both events show with the summary `Chairside · {name} · {service}`. **Record:** screenshot.
10. Open Alex's and James's chats with the owner. **Record:** the message count of each thread (baseline).

## C. Pairing from scratch

11. Make sure the simulator has no stored pairing. The simulator does not keep app storage between launches, so a fresh launch starts unpaired.
12. Start the glasses app in the simulator and pair it with the server using the pairing code flow. **Record:** time from launch to the paired screen; screenshot.
13. Confirm the glasses show the idle/empty queue state.

## D. Moment 1: Alex, haircut, one press

14. As Alex, send: `Can I get a haircut Saturday 5 Dec at 3pm?` **Record:** the message id and the send time.
15. Wait for the card on the glasses. **Record:** time from send to card visible; screenshot of the card (expected: Alex · Haircut, Sat 5 Dec 15:00, free for 45 min).
16. Press once (the ring or the temple; in the simulator, a click) to approve. **Record:** tap time; time until the reply is visible in Alex's thread.
17. Check Alex's thread: a reply in his thread. **Record:** the reply message id; message count after.
18. Check Google Calendar: a new event 15:00-15:45 on Sat 5 Dec. **Record:** event id, screenshot, total event count on that day.

## E. Moment 2: James, same time, offer, yes

19. As James, send: `Can I get a skin fade Saturday 5 Dec at 3pm?` **Record:** the message id.
20. The card on the glasses offers 16:00 (the next free time). **Record:** screenshot of the card.
21. Press to send the offer. **Record:** the offer message id in James's thread.
22. As James, type `yes` (not the Book button). **Record:** the message id.
23. The server rechecks the calendar and books. **Record:** the booking message id, the new event id and its time, the receipt screenshot on the glasses.
24. Check Google Calendar: a second event at 16:00. **Record:** screenshot, event count on Sat 5 Dec.

## F. Moment 3: Alex, beard trim, slot taken

25. **Record before:** messages below Alex's question in his thread; calendar event count on Sat 5 Dec.
26. As Alex, in the same chat, send: `Can you also do a beard trim Saturday 5 Dec at 5pm?`
27. Wait for the card. It shows 17:00 as free. Leave the card on screen. **Record:** screenshot.
28. In a terminal, run `npm run demo:block -- "2026-12-05 17:00" 30`. It prints `blocked {id} 2026-12-05 17:00-17:30 Busy`. **Record:** the event id.
29. Refresh Google Calendar and confirm the `Busy` block at 17:00.
30. Press to approve on the glasses. Expected: the card comes back with `Just taken · nothing sent` and `Offer Sat 5 Dec 17:45` highlighted. **Record:** screenshot of the `slot_taken` state.
31. **Record after:** the messages below Alex's question and the Sat 5 Dec calendar event count excluding the Busy block. Both must equal the "before" values from step 25 (no message sent, no duplicate event).

## G. Reconnect check

32. With the glasses app open and paired, stop the server (Ctrl+C in its terminal). **Record:** the time.
33. Restart the server with the same command. **Record:** the time it is listening again.
34. Watch the glasses app without touching it. It must reconnect without asking for pairing. **Record:** time from server restart to the glasses showing connected; screenshot.
35. Send one more test DM as James and confirm a card still arrives. **Record:** pass or fail.

## H. Cleanup

36. Run `npm run demo:reset`. **Record:** the output. Only events marked `chairsideDemo=1` are removed; real bookings made in moments 1 and 2 stay. (The runner deletes only the demo events it created itself, and only while they are unchanged.)
37. Fill in `docs/evidence/live-smoke.md` with every recorded value. Rerun the checklist after any fix.

## Known limits of the runner

- **Reply visible on the customer's screen.** The runner records when Telegram confirmed the reply (the Bot API's answer). The moment the reply appears in Alex's chat is measured afterwards from the screen recording.
- **Two devices, one lost answer.** If two paired devices press the same card and one of them loses its HTTP answer, that device can show "Not confirmed" before the booking's receipt arrives. The demo uses one device.
- **The Book button.** With `CALLBACKS_SUPPORTED=true`, David's offer also carries a Book button. A tap accepts the offer but leaves no typed message, so the runner stops at its "typed a reply" check. The recorded run set `CALLBACKS_SUPPORTED=false` in the shell (`.env` unchanged), so James could only accept by typing, as the narration says.
- **The words of James's reply.** Chairside never keeps message text, so the runner can prove that a typed reply accepted the offer, not that it read exactly "yes" ("ok" also accepts). The screen recording shows the "yes".
- **Hands off the simulator.** Scrolling a card's list is handled by the glasses themselves and tells the app nothing, so a stray swipe in the simulator during a hold could move the highlight before the runner's press. Don't touch the simulator during the run.
