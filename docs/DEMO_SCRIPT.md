# Chairside recording script

## Before recording

- [ ] Use the dedicated shop calendar and a live Telegram Business connection with permission to reply. In PowerShell, set `$env:SHOP_CONFIG_PATH = '../../config/shop.recording.json'` in the shell that runs the demo and starts the server. The recording config is for David's Barbers.
- [ ] Set Google Calendar's display zone to New York. Open week view on **Saturday 5 Dec 2026** and check that 14:00 to 18:30 is free. Rehearse with another `--day`. The 15:00 and 16:00 bookings stay on the calendar after each run.
- [ ] Use two consenting customers' accounts. Their Telegram first names must be Alex and James. Put their two comma-separated Telegram user IDs in `SMOKE_CUSTOMER_IDS` in `apps/server/.env`. For the take, set the owner's Telegram name to David so customers see his name in their chat header.
- [ ] Put the simulator on the left, Telegram Desktop at top right and Calendar at bottom right. Each customer types on their own phone. Show that customer's existing chat with David on the desktop. Crop out the chat list and notifications. Keep Saturday's hours legible and the terminal off camera.
- [ ] From the repository root, run `npm run smoke:live -- --day 2026-12-05` for the take itself. It resets and seeds the demo events, starts the server and simulator, handles pairing, makes every press, adds the Busy block and writes timings to `docs/evidence/live-smoke.md`. Follow the pairing prompt off camera. In Telegram, people send only the messages the runner prints.
- [ ] After the offer, James types `yes` on his phone. Leave the Book button alone. During Alex's beard-trim request, the terminal asks twice how many messages are below his question. Enter the count you see each time.
- [ ] Separately, time the same booking by hand on your phone, from Alex sending his haircut question to the confirmation in his chat with the event saved. Use a rehearsal day for this. Fill the phone time from your stopwatch and the glasses times from the live report before you record your voice.
- [ ] Capture the screen footage first. Record your voice and webcam over the finished video. Leave room for your face and captions without covering a highlighted action, the latest message or an appointment time.

## Shot list and exact captions

Keep each ring press and its result together. Leave a beat for the viewer to read each reply.

| Time | Even G2 simulator (left) | Telegram Desktop, customer view (top right) | Google Calendar, week view (bottom right) | Captions |
| --- | --- | --- | --- | --- |
| 0:00–0:12 | Sync the voice recording to the 3-2-1 countdown beeps, then reveal Chairside's home screen. | Show David's name at the top of Alex's chat. | Frame Saturday 5 Dec with the afternoon hours visible. | Chairside at David's Barbers<br>Saturday 5 Dec 2026 |
| 0:12–0:50 | Hold on `NEW REQUEST` with `Alex · Haircut` and `Sat 5 Dec · 15:00 · ● free (45 min)` legible below it. Show the first action, `Book & reply`, already highlighted. Catch the press, the receipt `● Booked Sat 5 Dec 15:00` and the return home. | Alex sends `Can I get a haircut Saturday 5 Dec at 3pm?` on his phone. Hold on his question and the confirmation from David directly below it. | Show 15:00 free, then `Chairside · Alex · Haircut` from 15:00 to 15:45. | Alex's haircut, 15:00 to 15:45<br>One press confirms it in his chat. |
| 0:50–1:40 | Show `Offer Sat 5 Dec 16:00` already highlighted. Hold through one press. After James replies, catch `● James accepted · Booked Sat 5 Dec 16:00`. | James sends `Can I get a skin fade Saturday 5 Dec at 3pm?` on his phone. Show David's offer. Give James time to read it, type `yes` and see the confirmation. | Keep Alex's 15:00 event visible. Hold on the gap at 16:00 until James accepts, then show `Chairside · James · Skin fade` from 16:00 to 16:45. | David offers 16:00.<br>James types "yes" on his phone. |
| 1:40–2:25 | Hold Alex's free 17:00 card while the Busy block appears. Show the press on `Book & reply`. Hold on `Just taken · nothing sent` with 17:45 highlighted. | On his phone, Alex sends `Can you also do a beard trim Saturday 5 Dec at 5pm?` in the same chat. Show his haircut question and David's confirmation above it. Keep the beard-trim question visible as the last message through the press. | Show the runner's `Busy` block from 17:00 to 17:30 while the card still says free. After the press, hold on the block so viewers can see there's no beard trim. | 17:00 just filled. Nothing sent.<br>Alex's next opening is 17:45. |
| 2:25–2:38 | Replay Alex's haircut booking with the phone stopwatch and live glasses time. | Show Alex's haircut question, then David's confirmation. | Show the saved 15:00 haircut beside the confirmation. | Phone {{phone_workflow_seconds}} s<br>Glasses {{glasses_workflow_seconds}} s |
| 2:38–2:50 | Show Alex's haircut card appearing, then the ring press. | Keep the reply visible as the press-to-reply time appears. | Keep Alex's haircut event in frame. | Message to card {{dm_to_card_seconds}} s<br>Ring press to reply {{tap_to_reply_seconds}} s |
| 2:50–3:00 | End on the home screen from Alex's haircut booking. | Leave David's haircut confirmation visible. | Hold on the two bookings. | David approves each booking or offer.<br>Chairside never stores message text. |

## Narration

Allow about 2:45 for speech. Each **(press)** marks the moment a ring press happens on screen: pause there, let the result show, then go on.

**0:00–0:12**

David's giving a haircut, scissors in one hand, comb in the other. The Even Hub simulator stands in for his Even G2 glasses and Even Realities R1 ring.

**0:12–0:50**

On his phone, Alex asks David for a haircut at three on Saturday. This is their usual Telegram chat. About three seconds later, David sees the request on his glasses. His phone stays in his pocket. Chairside's already checked his Google Calendar for the full forty-five-minute haircut. "Book and reply" is highlighted. One press on his ring says yes to three. **(press)** Look at David's calendar, bottom right. Chairside checks again and books Alex from three to three forty-five. Alex gets the confirmation from David's own Telegram account, right under his question.

**0:50–1:40**

James asks for a skin fade at three that same Saturday. Alex has that slot, and a skin fade takes forty-five minutes too. Chairside leaves five minutes between appointments and offers times on the quarter hour. That makes four the next opening. It's already highlighted on David's glasses. He presses his ring once **(press)** and James gets the offer from David's account. Four is still open on the calendar while James reads the offer on his phone. James types "yes" to the time David just offered. Chairside checks four again, books James until four forty-five and confirms in his chat. David's glasses tell him James accepted. He doesn't have to press again.

**1:40–2:25**

Alex asks for a beard trim at five in the same chat. David's card shows he's free for the twenty-minute trim. What if someone takes that slot while David's reading? I'll mark five to five thirty as Busy on his calendar, bottom right. When David presses his ring to book **(press)**, Chairside checks the calendar again. His glasses say "Just taken · nothing sent" and highlight the next opening, five forty-five. Alex's question is still the last message. There's no beard trim on the calendar. David can swipe up or down on his ring or a temple touchpad for other times or "Not now." A double press leaves the card waiting. **(double press)**

**2:25–2:50**

I timed Alex's haircut booking by hand on my phone. From his question to David's confirmation, with the appointment saved, that's {{phone_workflow_seconds}} seconds. The live run with the glasses takes {{glasses_workflow_seconds}} seconds. From David pressing his ring **(press, replayed)** to the reply in Alex's chat, it's {{tap_to_reply_seconds}} seconds.

**2:50–3:00**

David approves every booking or offer without picking up his phone or typing a word. Chairside never stores the message text.

## Retake tips

- If an opening differs, check the New York display zone, the recording date and the afternoon's events. For another take on 5 Dec, clear only the prior take's bookings from the dedicated calendar. The runner resets the marked seeds and demo blocks.
- Give James time to read before he types `yes`. His receipt lasts about two seconds. Hold that frame in the edit if it goes by too fast to read.
- For Alex's beard trim, compare the two counts below his question, just before and just after the press. Both should be zero. Keep the chat and the Busy block in frame long enough to see that Chairside added neither a reply nor an appointment.
- If Calendar is slow to refresh, keep recording until the event appears. Use the original timestamps for the timing overlay, even if you hold a frame in the edit.
