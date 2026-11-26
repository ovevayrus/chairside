# Live end-to-end smoke (US-015)

Run 2026-11-26T06:07:08.271Z to 2026-11-26T06:12:23.313Z by `npm run smoke:live` (`scripts/smoke-live.mjs`): real Telegram (`business` mode) and real Google Calendar; the glasses are the Even Hub simulator, not G2 hardware. Shop config `shop.recording.json` (America/New_York), booking day 2027-01-23 (Saturday 23 Jan). Node v24.13.0 on win32.

Result: **PASS**

Recorded: Telegram message ids, Chairside request and action ids, calendar event ids, times, counts and statuses. Not recorded: message text, names, Telegram user or chat ids. Screenshots are taken only when the customer accounts are named Alex or James.

## Timings (Moment 1)

| Interval | Seconds |
| --- | --- |
| Customer's DM (Telegram timestamp) to the card on the glasses. Telegram timestamps are whole seconds, so this reads up to 1 s high; it includes the 2.5 s wait for follow-up messages | 2.98 |
| DM received by the server to the card on the glasses | 2.81 |
| Tap to the server holding the action | 0.03 |
| Tap to the reply sent (Telegram confirmed it) | 1.17 |
| Tap to the receipt on the glasses | 1.39 |
| The whole glasses workflow: DM (Telegram timestamp) to the reply sent, with the card held 3 s before the tap as the owner's reading time | 7.46 |

Server-side times come from the server's own records. Those records do not tie an update to a chat, so a message from another chat at the same moment could shift the received times.

## Pairing from scratch

- Simulator launch to the app ready: 0.8 s; to a pairing code on the glasses: 0.75 s.
- Code shown to paired (the owner typed `/pair CODE` in the bot chat): 46.28 s.
- Paired to the live channel: 0.01 s.

## Moment 1: one tap books it

- DM message id(s): `325287`; request `a561f2b4-c78a-4074-91e6-dba4e3993c69`; parsed book, haircut, Sat 23 Jan 15:00.
- Tap result: ok. Reply message id 325288; action `226dfc7e-b0ed-4025-abad-c8411e6d8f78`.
- Calendar event `rt6gnmgrobkknpgjmq3ghlsfae` at Sat 23 Jan 15:00-15:45, read back from Google Calendar: true.

## Moment 2: slot taken, offer, "yes"

- DM message id(s): `325289`; request `feccb718-7992-4da1-a456-09e65b23ed2b`; DM to card 3.28 s (Telegram timestamp).
- Offer for Sat 23 Jan 16:00-16:45: message id 325290; offer status after the tap active.
- James typed a reply that accepted the offer (asked to type "yes"; message id(s) `325291`); booking confirmation message id 325292; offer status accepted.
- Calendar event `i3031o3vmvb97dkeakubof5s10` at Sat 23 Jan 16:00-16:45, read back from Google Calendar: true. "Yes" received to the booking confirmed: 3.91 s.

## Moment 3: the slot is taken while the card is on screen

- Request `11c06dc8-b231-4a57-9bcd-17b4b9a81192`; the card showed Sat 23 Jan 17:00 free.
- Foreign block `1lo71igjingqnums4fal48kg9p` inserted at 2027-01-23 17:00-17:30 before the tap.
- Tap result: slot_taken; the card came back as version 2, offering Sat 23 Jan 17:45.

| Count | Before the tap | After the tap |
| --- | --- | --- |
| Messages below the customer's question in the chat (operator count from the screen; the Bot API cannot read chat history) | 0 | 0 |
| Messages Chairside has sent in this customer's thread (server records) | 10 | 10 |
| Events on 2027-01-23 in Google Calendar, excluding the block | 2 | 2 |

## Reconnect

- Server stopped at 2026-11-26T06:11:57.942Z; the glasses showed the status screen after 2.13 s.
- Server restarted at 2026-11-26T06:12:00.376Z and listening after 1.62 s; the glasses were back on root 2.23 s after the restart (link states: link=connecting, link=offline, link=live). No pairing asked: true.
- A new DM after the restart opened a card: true.

## Clean start

- `demo:reset` equivalent removed 0 demo event(s); seeded: `ti2fv8elakq7b60mj7gvap03f5` 2026-11-26 14:00-14:45; `o8tics77uhqrlsjij7m018vu66` 2026-11-26 16:15-16:35.
- Cleanup at the end: removed this run's 3 demo event(s) (the seeded appointments and the Moment 3 block); the Moment 1 and 2 bookings stay; the last DM stays as a waiting card.

## Checks

- PASS: paired from scratch with a code sent in Telegram
- PASS: Moment 1: the server holds the request behind the card
- PASS: Moment 1: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: Moment 1: the card is from Alex (exact Telegram first name; the screenshots are public evidence)
- PASS: Moment 1: Alex writes from a different account than the other customer
- PASS: Moment 1: the card carries a new message from this run
- PASS: Moment 1 parsed a haircut at 15:00 (got book, haircut, Sat 23 Jan 15:00)
- PASS: Moment 1: the card did not change during the hold (version 1, pending)
- PASS: Moment 1: the highlighted action is Book & reply at 15:00 (got book Sat 23 Jan 15:00)
- PASS: Moment 1: the glasses still show this card with its first action selected
- PASS: Moment 1 tap answered ok (got ok)
- PASS: Moment 1 reply sent: Telegram returned a message id
- PASS: Moment 1 booking recorded
- PASS: Moment 1 booked 15:00 (got Sat 23 Jan 15:00-15:45)
- PASS: Moment 1 event read back from Google Calendar
- PASS: Moment 2: the server holds the request behind the card
- PASS: Moment 2: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: Moment 2: the card is from James (exact Telegram first name; the screenshots are public evidence)
- PASS: Moment 2: James writes from a different account than the other customer
- PASS: Moment 2: the card carries a new message from this run
- PASS: Moment 2 parsed a skin fade at 15:00 (got book, skin_fade, Sat 23 Jan 15:00)
- PASS: Moment 2: the card did not change during the hold (version 1, pending)
- PASS: Moment 2: the highlighted action is an offer later that afternoon (got offer Sat 23 Jan 16:00)
- PASS: Moment 2: the glasses still show this card with its first action selected
- PASS: Moment 2 offer tap answered ok (got ok)
- PASS: Moment 2 offer sent: Telegram returned a message id
- PASS: Moment 2 James typed a reply that accepted the offer (its message id is recorded)
- PASS: Moment 2 "yes" booked it and the confirmation went out (status ok, state sent)
- PASS: Moment 2 confirmation sent: Telegram returned a message id
- PASS: Moment 2 booking recorded
- PASS: Moment 2 booked the offered time (got Sat 23 Jan 16:00-16:45)
- PASS: Moment 2 event read back from Google Calendar
- PASS: Moment 2 offer marked accepted (got accepted)
- PASS: Moment 3: the server holds the request behind the card
- PASS: Moment 3: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: Moment 3: the card is from Alex (exact Telegram first name; the screenshots are public evidence)
- PASS: Moment 3: Alex writes from the same chat as before
- PASS: Moment 3: the card carries a new message from this run
- PASS: Moment 3 parsed a beard trim at 17:00 (got book, beard_trim, Sat 23 Jan 17:00)
- PASS: Moment 3: the card did not change during the hold (version 1, pending)
- PASS: Moment 3: the highlighted action is Book & reply at 17:00 (got book Sat 23 Jan 17:00)
- PASS: Moment 3: the glasses still show this card with its first action selected
- PASS: Moment 3 tap answered slot_taken (got slot_taken)
- PASS: Moment 3 the card now offers the next opening (got offer Sat 23 Jan 17:45)
- PASS: Moment 3 Alex's thread did not change (operator count before 0, after 0)
- PASS: Moment 3 sent no message (before 10, after 10)
- PASS: Moment 3 wrote no event (before 2, after 2)
- PASS: Moment 3 has no reply id and no booking row
- PASS: the restart did not ask to pair again
- PASS: post-restart: the server holds the request behind the card
- PASS: post-restart: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: post-restart: the card is from James (exact Telegram first name; the screenshots are public evidence)
- PASS: post-restart: James writes from the same chat as before
- PASS: post-restart: the card carries a new message from this run
- PASS: a DM after the restart opened a card
- PASS: only this run's requests and receipts appeared on the glasses (other cards: 0, other updates: 0)
- PASS: today's calendar still holds demo events only, so the root screen named no real customer (non-demo: 0)

## Screenshots

- `docs/evidence/live-smoke-01-pairing.png`: the pairing screen (single-use code, long expired)
- `docs/evidence/live-smoke-02-root-paired.png`: paired: the root screen
- `docs/evidence/live-smoke-03-m1-card.png`: Moment 1: the card, smart default highlighted
- `docs/evidence/live-smoke-04-m1-receipt.png`: Moment 1: the receipt after one tap
- `docs/evidence/live-smoke-05-m2-card.png`: Moment 2: 15:00 is taken; the card offers the next opening
- `docs/evidence/live-smoke-06-m2-offer-sent.png`: Moment 2: the offer went out
- `docs/evidence/live-smoke-07-m2-booked.png`: Moment 2: the "yes" booked it; the glasses show the update
- `docs/evidence/live-smoke-08-m3-card.png`: Moment 3: the card shows 17:00 free
- `docs/evidence/live-smoke-09-m3-slot-taken.png`: Moment 3: nothing sent; the card says the slot was just taken and offers the next opening
- `docs/evidence/live-smoke-10-reconnect-status.png`: server stopped: the status screen
- `docs/evidence/live-smoke-11-reconnect-root.png`: server back: root again, no pairing
- `docs/evidence/live-smoke-12-reconnect-card.png`: a DM after the restart still opens a card

## Timeline (UTC, for cutting the screen recording)

- 2026-11-26T06:07:10.049Z clean start: removed 0 demo event(s), seeded 2
- 2026-11-26T06:07:12.311Z server listening after 1.9 s
- 2026-11-26T06:07:12.716Z launching the simulator with fresh storage (pairing from scratch)
- 2026-11-26T06:07:13.786Z waiting for the owner to pair
- 2026-11-26T06:08:00.041Z paired
- 2026-11-26T06:08:00.045Z waiting for the Moment 1 DM
- 2026-11-26T06:09:50.995Z Moment 1 card shown (request a561f2b4-c78a-4074-91e6-dba4e3993c69)
- 2026-11-26T06:09:54.291Z tap (request a561f2b4-c78a-4074-91e6-dba4e3993c69)
- 2026-11-26T06:09:57.761Z Moment 1 done
- 2026-11-26T06:09:57.762Z waiting for the Moment 2 DM
- 2026-11-26T06:10:51.389Z Moment 2 card shown (request feccb718-7992-4da1-a456-09e65b23ed2b)
- 2026-11-26T06:10:54.625Z tap (request feccb718-7992-4da1-a456-09e65b23ed2b)
- 2026-11-26T06:10:55.531Z waiting for the "yes"
- 2026-11-26T06:11:07.915Z offer accepted
- 2026-11-26T06:11:09.819Z Moment 2 done
- 2026-11-26T06:11:09.820Z waiting for the Moment 3 DM
- 2026-11-26T06:11:41.399Z Moment 3 card shown (request 11c06dc8-b231-4a57-9bcd-17b4b9a81192)
- 2026-11-26T06:11:42.265Z foreign block inserted at 2027-01-23 17:00-17:30
- 2026-11-26T06:11:55.420Z tap (request 11c06dc8-b231-4a57-9bcd-17b4b9a81192)
- 2026-11-26T06:11:57.942Z Moment 3 done
- 2026-11-26T06:11:59.050Z server stopped
- 2026-11-26T06:12:01.994Z server restarted
- 2026-11-26T06:12:02.901Z waiting for the post-restart DM
- 2026-11-26T06:12:20.277Z post-restart card shown (request e7f93065-b792-46f9-8d10-4a2de6f10b28)
- 2026-11-26T06:12:20.517Z reconnect done
