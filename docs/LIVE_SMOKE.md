# Live smoke checklist (US-015)

The live end-to-end run with real Telegram and real Google Calendar. Run it with `npm run smoke:live`: the runner starts the server, Vite and the simulator, taps the glasses and inserts the Moment 3 calendar block itself. The people only send Telegram messages, which the runner prints word for word on lines starting `[smoke] >>>`. Before every tap it checks that the card is the expected request and that the highlighted action is the expected one, so it never acts on someone else's message.

A passing run writes everything marked **Record** below to `docs/evidence/live-smoke.md` (plus `live-smoke.json` and `live-smoke-*.png`). A failed run leaves that evidence alone and writes its report to `docs/evidence/live-smoke-run/`, which git ignores. The runner records ids, times, counts and statuses, never message text, names or Telegram user and chat ids. The screenshots are public, so it stops unless the customer accounts are named Anna or Omar.

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
3. Telegram Desktop is logged in as the customer accounts, with Telegram first names Anna and Omar; one account can play both. In Business mode they message the owner's account, not the bot. Put their Telegram user ids (from @userinfobot) in `SMOKE_CUSTOMER_IDS` in `apps/server/.env`, comma-separated: the runner acts only on cards from those chats.
3a. During the run, the terminal asks for two counts in Moment 3 (messages below Anna's beard-trim question, before and after the tap), and Omar's "yes" must be typed, not pressed as the Book button.
4. Google Calendar is open in week view on the week of Sat 5 Dec 2026, showing the shop calendar. Today the shop calendar holds only demo events: the glasses' root screen shows today's next bookings, and its screenshots are public.
5. Screen layout: simulator left, Telegram Desktop top right, Google Calendar bottom right.
6. By hand: start `npm run start:server`, `npm run start:glasses` and `npm run start:simulator` from the repository root. **Record:** start time, server log line showing it is listening.

## B. Clean start

7. Run `npm run demo:reset`. It prints one line per removed event and `removed N demo event(s)`. **Record:** the output.
8. Run `npm run demo:seed`. It prints two lines: Sami 14:00-14:45 Haircut and Yusuf 16:15-16:35 Beard trim, today in shop time. **Record:** both event ids and the local times.
9. Refresh Google Calendar. Confirm both events show with the summary `Chairside · {name} · {service}`. **Record:** screenshot.
10. Open Anna's and Omar's chats with the owner. **Record:** the message count of each thread (baseline).

## C. Pairing from scratch

11. Make sure the simulator has no stored pairing. The simulator does not keep app storage between launches, so a fresh launch starts unpaired.
12. Start the glasses app in the simulator and pair it with the server using the pairing code flow. **Record:** time from launch to the paired screen; screenshot.
13. Confirm the glasses show the idle/empty queue state.

## D. Moment 1: Anna, skin fade, one tap

14. As Anna, send: `Can I get a skin fade Saturday 5 Dec at 3pm?` **Record:** the message id and the send time.
15. Wait for the card on the glasses. **Record:** time from send to card visible; screenshot of the card (expected: Skin fade, Sat 5 Dec 15:00).
16. Tap once to approve. **Record:** tap time; time until the reply is visible in Anna's thread.
17. Check Anna's thread: a reply in her thread. **Record:** the reply message id; message count after.
18. Check Google Calendar: a new event 15:00-15:45 on Sat 5 Dec. **Record:** event id, screenshot, total event count on that day.

## E. Moment 2: Omar, same slot, offer, yes

19. As Omar, ask for the same slot (skin fade, Sat 5 Dec, 3pm). **Record:** the message id.
20. The card on the glasses offers 16:00 (the next free time). **Record:** screenshot of the card.
21. Tap to send the offer. **Record:** the offer message id in Omar's thread.
22. As Omar, reply `yes`. **Record:** the message id.
23. The server rechecks the calendar and books. **Record:** the booking message id, the new event id and its time, the receipt screenshot on the glasses.
24. Check Google Calendar: a second event at 16:00. **Record:** screenshot, event count on Sat 5 Dec.

## F. Moment 3: Anna, beard trim, slot taken

25. **Record before:** message count in Anna's thread; calendar event count on Sat 5 Dec.
26. As Anna, send: `can you also do a beard trim Sat 5 Dec 5pm?`
27. Wait for the card. It shows 17:00 as free. Leave the card on screen. **Record:** screenshot.
28. In a terminal, run `npm run demo:block -- "2026-12-05 17:00" 30`. It prints `blocked {id} 2026-12-05 17:00-17:30 Busy`. **Record:** the event id.
29. Refresh Google Calendar and confirm the `Busy` block at 17:00.
30. Tap to approve on the glasses. Expected text: `17:00 was just taken · next 17:45`. **Record:** screenshot of the `slot_taken` state.
31. **Record after:** Anna's thread message count and the Sat 5 Dec calendar event count excluding the Busy block. Both must equal the "before" values from step 25 (no message sent, no duplicate event).

## G. Reconnect check

32. With the glasses app open and paired, stop the server (Ctrl+C in its terminal). **Record:** the time.
33. Restart the server with the same command. **Record:** the time it is listening again.
34. Watch the glasses app without touching it. It must reconnect without asking for pairing. **Record:** time from server restart to the glasses showing connected; screenshot.
35. Send one more test DM as Anna and confirm a card still arrives. **Record:** pass or fail.

## H. Cleanup

36. Run `npm run demo:reset`. **Record:** the output. Only events marked `chairsideDemo=1` are removed; real bookings made in moments 1 and 2 stay.
37. Fill in `docs/evidence/live-smoke.md` with every recorded value. Rerun the checklist after any fix.
