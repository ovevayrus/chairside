# Chairside recording script

## Before recording

- [ ] Use the dedicated shop calendar and a live Telegram Business connection with permission to reply. In PowerShell, set `$env:SHOP_CONFIG_PATH = '../../config/shop.recording.json'` in the shell that runs the demo and starts the server. The recording config is for David's Barbers.
- [ ] Set Google Calendar's display zone to New York. Open week view on **Saturday 5 Dec 2026** and check that 14:00 to 18:30 is free. Rehearse with another `--day`. The 15:00 and 16:00 bookings stay on the calendar after each run.
- [ ] Use two consenting customers' accounts. Their Telegram first names must be Alex and James. Put their two comma-separated Telegram user IDs in `SMOKE_CUSTOMER_IDS` in `apps/server/.env`. For the take, set the owner's Telegram name to David so customers see his name in their chat header.
- [ ] Put the simulator on the left, Telegram Desktop at top right and Calendar at bottom right. Each customer types on their own phone. Show that customer's existing chat with David on the desktop. Crop out the chat list and notifications. Keep Saturday's hours legible and the terminal off camera.
- [ ] From the repository root, run `npm run smoke:live -- --day 2026-12-05` for the take itself. It resets and seeds the demo events, starts the server and simulator, handles pairing, makes every press, adds the Busy block and writes timings to `docs/evidence/live-smoke.md`. Follow the pairing prompt off camera. In Telegram, people send only the messages the runner prints.
- [ ] After the offer, James types `yes` on his phone. Leave the Book button alone. During Alex's beard-trim request, the terminal asks twice how many messages are below his question. Enter the count you see each time.
- [ ] Optional: time one booking by hand on your phone (unlock it, open the chat, check the calendar, add the event, type the reply) to check the "about a minute a booking" estimate in the narration. Use a rehearsal day for this.
- [ ] Capture the screen footage first. Record your voice and webcam over the finished video. Leave room for your face and captions without covering a highlighted action, the latest message or an appointment time.

## Shot list and exact captions

Keep each ring press and its result together. Leave a beat for the viewer to read each reply.

| Time | Even G2 simulator (left) | Telegram Desktop, customer view (top right) | Google Calendar, week view (bottom right) | Captions |
| --- | --- | --- | --- | --- |
| 0:00–0:43 | Sync the voice recording to the 3-2-1 countdown beeps, then reveal Chairside's home screen. | Show David's name at the top of Alex's chat. | Frame Saturday 5 Dec with the afternoon hours visible. | Chairside at David's Barbers<br>Hands full, phone in his pocket |
| 0:43–1:22 | Hold on `NEW REQUEST` with `Alex · Haircut` and `Sat 5 Dec · 15:00 · ● free (45 min)` legible below it. Show the first action, `Book & reply`, already highlighted. Catch the press, the receipt `● Booked Sat 5 Dec 15:00` and the return home. | Alex sends `Can I get a haircut Saturday 5 Dec at 3pm?` on his phone. Hold on his question and the confirmation from David directly below it. | Show 15:00 free, then `Chairside · Alex · Haircut` from 15:00 to 15:45. | One press: Google Calendar and Telegram<br>Reply sent from David's own account |
| 1:22–1:50 | Show `Offer Sat 5 Dec 16:00` already highlighted. Hold through one press. After James replies, catch `● James accepted · Booked Sat 5 Dec 16:00`. | James sends `Can I get a skin fade Saturday 5 Dec at 3pm?` on his phone. Show David's offer. Speed up while James reads it and types `yes`, then show the confirmation. | Keep Alex's 15:00 event visible, then show `Chairside · James · Skin fade` from 16:00 to 16:45. | David offers 16:00<br>James types "yes" on his phone |
| 1:50–2:20 | Hold Alex's free 17:00 card while the Busy block appears. Show the press on `Book & reply`. Hold on `Just taken · nothing sent` with 17:45 highlighted, then the double press back home. | On his phone, Alex sends `Can you also do a beard trim Saturday 5 Dec at 5pm?` in the same chat. Keep the beard-trim question visible as the last message through the press. | Show the `Busy` block from 17:00 to 17:30 while the card still says free. After the press, hold on the block so viewers can see there's no beard trim. | 17:00 just filled. Nothing sent.<br>No double booking. Next opening: 17:45 |
| 2:20–2:57 | End on the home screen. | Leave Alex's confirmation visible. | Hold on the two bookings. | His phone never left his pocket<br>No message text stored, no AI on customer chats |

## Narration

Allow about 2:40 for speech (about 320 words; the video runs about 3:00). Each **(press)** marks the moment a ring press happens on screen: pause there, let the result show, then go on.

**0:00–0:43**

This is David, halfway through a haircut, with his hands full. Like a lot of barbers, he takes bookings in DMs, so each message means stopping mid-cut, or leaving a customer waiting who might book elsewhere. With Chairside, though, David never has to touch his phone. He reads each request on his Even G2 glasses and answers with a press of his Even Realities R1 ring. In this demo, the Even simulator stands in for both.

**0:43–1:22**

Let's start with Alex. He texts David for a haircut on Saturday at three, in their usual Telegram chat. No app, no booking link. Seconds later it's on David's glasses, already checked against his calendar for the full forty-five minutes. One press books it. **(press)** That one press wrote to two apps: the haircut is in his Google Calendar, and Alex has his confirmation, sent from David's own account through Telegram Business.

**1:22–1:50**

Now James wants three o'clock too. It's taken, so the card suggests four, the next opening that fits. One press sends the offer. **(press)** James replies "yes" on his phone, and Chairside checks that four is still free before it books him and confirms. This time, David doesn't touch a thing.

**1:50–2:20**

Then Alex comes back for a beard trim at five. But what if someone grabs that slot while David's reading? I'll block it on his calendar. David presses. **(press)** Chairside checks again, sees five is gone, and sends nothing, so there's no double booking. Instead, his card suggests five forty-five. **(double press)**

**2:20–2:57**

So that's three requests, and David never touched his phone. It saves him about a minute a booking, but the real win is never putting the scissors down. He stays in control, approving every booking or offer. And for privacy, Chairside never stores the message text and never sends it to an AI. It's built for barbers, stylists and nail techs who book through Telegram, and their customers don't change a thing.

## Retake tips

- If an opening differs, check the New York display zone, the recording date and the afternoon's events. For another take on 5 Dec, clear only the prior take's bookings from the dedicated calendar. The runner resets the marked seeds and demo blocks.
- Give James time to read before he types `yes`. His receipt lasts about two seconds. Hold that frame in the edit if it goes by too fast to read.
- For Alex's beard trim, compare the two counts below his question, just before and just after the press. Both should be zero. Keep the chat and the Busy block in frame long enough to see that Chairside added neither a reply nor an appointment.
- If Calendar is slow to refresh, keep recording until the event appears.
