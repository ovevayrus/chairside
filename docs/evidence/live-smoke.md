# Live end-to-end smoke (US-015)

Run 2026-11-26T05:41:49.464Z to 2026-11-26T05:45:33.640Z by `npm run smoke:live` (`scripts/smoke-live.mjs`): real Telegram (`business` mode) and real Google Calendar; the glasses are the Even Hub simulator, not G2 hardware. Shop config `shop.recording.json` (America/New_York), booking day 2027-01-09 (Saturday 9 Jan). Node v24.13.0 on win32.

Result: **PASS**

Recorded: Telegram message ids, Chairside request and action ids, calendar event ids, times, counts and statuses. Not recorded: message text, names, Telegram user or chat ids. Screenshots are taken only when the customer accounts are named Alex or James.

## Timings (Moment 1)

| Interval | Seconds |
| --- | --- |
| Customer's DM (Telegram timestamp) to the card on the glasses. Telegram timestamps are whole seconds, so this reads up to 1 s high; it includes the 2.5 s wait for follow-up messages | 3.46 |
| DM received by the server to the card on the glasses | 2.8 |
| Tap to the server holding the action | 0.02 |
| Tap to the reply sent (Telegram confirmed it) | 0.99 |
| Tap to the receipt on the glasses | 1.21 |
| The whole glasses workflow: DM (Telegram timestamp) to the reply sent, with the card held 3 s before the tap as the owner's reading time | 7.74 |

Server-side times come from the server's own records. Those records do not tie an update to a chat, so a message from another chat at the same moment could shift the received times.

## Pairing from scratch

- Simulator launch to the app ready: 0.84 s; to a pairing code on the glasses: 0.74 s.
- Code shown to paired (the owner typed `/pair CODE` in the bot chat): 20.15 s.
- Paired to the live channel: 0.01 s.

## Moment 1: one tap books it

- DM message id(s): `325267`; request `3d02d92e-223d-4611-8afa-3de873771cb2`; parsed book, haircut, Sat 9 Jan 15:00.
- Tap result: ok. Reply message id 325268; action `29f4c174-ae3a-40fb-a70d-4601cd5b7915`.
- Calendar event `l0so8a6c37nll4njmbq1k5641o` at Sat 9 Jan 15:00-15:45, read back from Google Calendar: true.

## Moment 2: slot taken, offer, "yes"

- DM message id(s): `325269`; request `d3b04073-fca6-4ded-bd2e-146856a89aae`; DM to card 3.58 s (Telegram timestamp).
- Offer for Sat 9 Jan 16:00-16:45: message id 325270; offer status after the tap active.
- James typed a reply that accepted the offer (asked to type "yes"; message id(s) `325271`); booking confirmation message id 325272; offer status accepted.
- Calendar event `784005rvmlla4fajs0oroo71o1` at Sat 9 Jan 16:00-16:45, read back from Google Calendar: true. "Yes" received to the booking confirmed: 3.62 s.

## Moment 3: the slot is taken while the card is on screen

- Request `5c4727eb-b91f-48ad-bfc5-f0ddd74a1bbf`; the card showed Sat 9 Jan 17:00 free.
- Foreign block `tm96htku57t3fsrprt5hac93iv` inserted at 2027-01-09 17:00-17:30 before the tap.
- Tap result: slot_taken; the card came back as version 2, offering Sat 9 Jan 17:45.

| Count | Before the tap | After the tap |
| --- | --- | --- |
| Messages below the customer's question in the chat (operator count from the screen; the Bot API cannot read chat history) | 0 | 0 |
| Messages Chairside has sent in this customer's thread (server records) | 8 | 8 |
| Events on 2027-01-09 in Google Calendar, excluding the block | 2 | 2 |

## Reconnect

- Server stopped at 2026-11-26T05:44:30.030Z; the glasses showed the status screen after 2.3 s.
- Server restarted at 2026-11-26T05:44:32.639Z and listening after 1.9 s; the glasses were back on root 4.25 s after the restart (link states: link=connecting, link=offline, link=polling). No pairing asked: true.
- A new DM after the restart opened a card: true.

## Clean start

- `demo:reset` equivalent removed 0 demo event(s); seeded: `1gt9svtj0jsb2372qbucjg412u` 2026-11-26 14:00-14:45; `p07cmhnlq9tlf293hgbv70o7t2` 2026-11-26 16:15-16:35.
- Cleanup at the end: removed this run's 3 demo event(s) (the seeded appointments and the Moment 3 block); the Moment 1 and 2 bookings stay; the last DM stays as a waiting card.

## Checks

- PASS: paired from scratch with a code sent in Telegram
- PASS: Moment 1: the server holds the request behind the card
- PASS: Moment 1: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: Moment 1: the card is from Alex (exact Telegram first name; the screenshots are public evidence)
- PASS: Moment 1: Alex writes from a different account than the other customer
- PASS: Moment 1: the card carries a new message from this run
- PASS: Moment 1 parsed a haircut at 15:00 (got book, haircut, Sat 9 Jan 15:00)
- PASS: Moment 1: the card did not change during the hold (version 1, pending)
- PASS: Moment 1: the highlighted action is Book & reply at 15:00 (got book Sat 9 Jan 15:00)
- PASS: Moment 1: the glasses still show this card with its first action selected
- PASS: Moment 1 tap answered ok (got ok)
- PASS: Moment 1 reply sent: Telegram returned a message id
- PASS: Moment 1 booking recorded
- PASS: Moment 1 booked 15:00 (got Sat 9 Jan 15:00-15:45)
- PASS: Moment 1 event read back from Google Calendar
- PASS: Moment 2: the server holds the request behind the card
- PASS: Moment 2: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: Moment 2: the card is from James (exact Telegram first name; the screenshots are public evidence)
- PASS: Moment 2: James writes from a different account than the other customer
- PASS: Moment 2: the card carries a new message from this run
- PASS: Moment 2 parsed a skin fade at 15:00 (got book, skin_fade, Sat 9 Jan 15:00)
- PASS: Moment 2: the card did not change during the hold (version 1, pending)
- PASS: Moment 2: the highlighted action is an offer later that afternoon (got offer Sat 9 Jan 16:00)
- PASS: Moment 2: the glasses still show this card with its first action selected
- PASS: Moment 2 offer tap answered ok (got ok)
- PASS: Moment 2 offer sent: Telegram returned a message id
- PASS: Moment 2 James typed a reply that accepted the offer (its message id is recorded)
- PASS: Moment 2 "yes" booked it and the confirmation went out (status ok, state sent)
- PASS: Moment 2 confirmation sent: Telegram returned a message id
- PASS: Moment 2 booking recorded
- PASS: Moment 2 booked the offered time (got Sat 9 Jan 16:00-16:45)
- PASS: Moment 2 event read back from Google Calendar
- PASS: Moment 2 offer marked accepted (got accepted)
- PASS: Moment 3: the server holds the request behind the card
- PASS: Moment 3: the card comes from a declared test customer chat (SMOKE_CUSTOMER_IDS)
- PASS: Moment 3: the card is from Alex (exact Telegram first name; the screenshots are public evidence)
- PASS: Moment 3: Alex writes from the same chat as before
- PASS: Moment 3: the card carries a new message from this run
- PASS: Moment 3 parsed a beard trim at 17:00 (got book, beard_trim, Sat 9 Jan 17:00)
- PASS: Moment 3: the card did not change during the hold (version 1, pending)
- PASS: Moment 3: the highlighted action is Book & reply at 17:00 (got book Sat 9 Jan 17:00)
- PASS: Moment 3: the glasses still show this card with its first action selected
- PASS: Moment 3 tap answered slot_taken (got slot_taken)
- PASS: Moment 3 the card now offers the next opening (got offer Sat 9 Jan 17:45)
- PASS: Moment 3 Alex's thread did not change (operator count before 0, after 0)
- PASS: Moment 3 sent no message (before 8, after 8)
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

- 2026-11-26T05:41:51.293Z clean start: removed 0 demo event(s), seeded 2
- 2026-11-26T05:41:53.407Z server listening after 1.8 s
- 2026-11-26T05:41:53.845Z launching the simulator with fresh storage (pairing from scratch)
- 2026-11-26T05:41:54.943Z waiting for the owner to pair
- 2026-11-26T05:42:15.057Z paired
- 2026-11-26T05:42:15.061Z waiting for the Moment 1 DM
- 2026-11-26T05:42:26.494Z Moment 1 card shown (request 3d02d92e-223d-4611-8afa-3de873771cb2)
- 2026-11-26T05:42:29.754Z tap (request 3d02d92e-223d-4611-8afa-3de873771cb2)
- 2026-11-26T05:42:33.011Z Moment 1 done
- 2026-11-26T05:42:33.012Z waiting for the Moment 2 DM
- 2026-11-26T05:43:00.604Z Moment 2 card shown (request d3b04073-fca6-4ded-bd2e-146856a89aae)
- 2026-11-26T05:43:03.873Z tap (request d3b04073-fca6-4ded-bd2e-146856a89aae)
- 2026-11-26T05:43:04.646Z waiting for the "yes"
- 2026-11-26T05:43:14.303Z offer accepted
- 2026-11-26T05:43:16.131Z Moment 2 done
- 2026-11-26T05:43:16.132Z waiting for the Moment 3 DM
- 2026-11-26T05:43:32.600Z Moment 3 card shown (request 5c4727eb-b91f-48ad-bfc5-f0ddd74a1bbf)
- 2026-11-26T05:43:33.246Z foreign block inserted at 2027-01-09 17:00-17:30
- 2026-11-26T05:44:19.102Z tap (request 5c4727eb-b91f-48ad-bfc5-f0ddd74a1bbf)
- 2026-11-26T05:44:30.030Z Moment 3 done
- 2026-11-26T05:44:31.286Z server stopped
- 2026-11-26T05:44:34.537Z server restarted
- 2026-11-26T05:44:37.180Z waiting for the post-restart DM
- 2026-11-26T05:45:30.366Z post-restart card shown (request 99ee4610-50dd-426a-8aa7-82958ed00de2)
- 2026-11-26T05:45:30.609Z reconnect done
