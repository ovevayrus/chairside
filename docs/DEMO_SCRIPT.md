# Chairside recording script

## Before recording

- [ ] Use `config/shop.recording.json`. In PowerShell, set `$env:SHOP_CONFIG_PATH = '../../config/shop.recording.json'` in the shell that launches the server and the one running the demo commands. Set Google Calendar's display zone to New York to match the glasses.
- [ ] Start the server with the dedicated shop calendar and the live Telegram Business connection with reply rights. Open Chairside in the Even G2 simulator, pair it and make sure cards are active.
- [ ] From the repository root, run `npm run demo:reset`, then `npm run demo:seed`. The seed adds Sami and Yusuf on today's shop schedule. Open Google Calendar in week view on **Saturday 5 Dec 2026**. Check that the afternoon slots needed below are free before the take.
- [ ] Use consenting customer accounts named Anna and Omar. Open each customer's existing thread with Karim's own account in Telegram Desktop. Crop the chat list and unrelated notifications out of the recording.
- [ ] Put the simulator on the left, customer Telegram Desktop at top right and Calendar week view at bottom right. Frame Saturday so viewers can read the hours. Keep the terminal outside the capture.
- [ ] Record the phone stopwatch run separately. For both workflows, start when Anna sends the DM and stop when she sees the confirmation, with the calendar event already saved. Record the live send, card, tap and reply timestamps in `docs/evidence/live-smoke.md`. Fill the timing slots before recording the narration.
- [ ] Capture the screen footage first. Record your own voice and webcam over the finished cut. Leave room for your face and the captions without covering the selected action, the newest message or the event time.

## Shot list and exact captions

Show the captions in each row in order. Hold the original footage through each tap and its result.

| Time | Even G2 simulator (left) | Telegram Desktop, customer view (top right) | Google Calendar, week view (bottom right) | Captions |
| --- | --- | --- | --- | --- |
| 0:00 to 0:12 | Title card with the 3-2-1 countdown (its beeps sync the narration recording), then the simulator on its home screen. | Reveal Anna's chat with Karim. | Reveal Saturday 5 Dec. | Hands busy. Bookings arrive in Telegram. |
| 0:12 to 0:50 | Hold Anna's free 15:00 card. Tap "Book & reply" once. Catch the receipt. | As Anna, send "Can I get a skin fade Saturday 5 Dec at 3pm?" Keep her question and Karim's reply together. | Show the empty slot, then the event "Chairside · Anna · Skin fade" from 15:00 to 15:45. Hold on both results. | Anna asks for Saturday at 15:00.<br>One tap books the cut and replies in her chat. |
| 0:50 to 1:40 | Show the 16:00 offer already highlighted. Tap it, then catch Omar's booking receipt after he answers. | As Omar, send "Can I get a skin fade Saturday 5 Dec at 3pm?" Hold on the delivered offer for more than 15 seconds after the tap. Reply "yes" and show the confirmation. | Keep Anna at 15:00 in view. Show 16:00 still open as Omar reads, then show his new event at 16:00. | Anna has 15:00. Karim offers 16:00.<br>Omar says yes. Chairside checks again and books him. |
| 1:40 to 2:25 | Hold Anna's free 17:00 card until the Busy block appears. Tap "Book & reply." Frame "Just taken · nothing sent" and the new 17:45 offer. Leave it highlighted. | As Anna, send "can you also do a beard trim Sat 5 Dec 5pm?" Keep her question as the last message through the tap. | While the free card is visible, run `npm run demo:block -- "2026-12-05 17:00" 30` off camera. Refresh to show Busy from 17:00 to 17:30. Hold on the same block after the tap. | 17:00 was free when Anna's card appeared.<br>Nothing sent. The next opening is 17:45. |
| 2:25 to 2:50 | Replay Anna's card and tap from the first booking. Overlay the phone stopwatch and the glasses result. | Keep the DM and reply visible as the start and finish of both timings. | Hold Anna's saved event beside her confirmation. | Same booking, from DM to confirmation.<br>Phone {{phone_workflow_seconds}} s. Glasses {{glasses_workflow_seconds}} s.<br>DM to card {{dm_to_card_seconds}} s. Tap to reply {{tap_to_reply_seconds}} s. |
| 2:50 to 3:00 | Hold on the simulator with room for the closing captions. | Leave Anna's thread visible. | Leave the booked appointments visible. | Chairside. Book clients without putting down the scissors.<br>You approve every booking or offer. Message text is never stored. |

## Narration

Aim for about 2:45 of speech. Leave a beat after each tap so viewers can read the result.

**0:00 to 0:12**

Karim's in the middle of a haircut when Anna messages him. His phone's in his pocket. The G2 simulator on the left shows his view.

**0:12 to 0:50**

Anna's typing in her usual Telegram chat with Karim. She'd like a skin fade on Saturday, December fifth, at three. The shop's calendar is just below her chat. When her request comes in, Chairside checks whether there's time for the whole cut. There's her name on the glasses, and three o'clock is free. Karim taps Book and reply. Look at Saturday afternoon. The cut runs until three forty-five, and Anna can read Karim's confirmation right under her question.

**0:50 to 1:40**

Omar wants a skin fade at exactly the same time. Here's his chat with Karim. Anna has three o'clock now, so the first action on Karim's glasses is to offer four, the next opening that fits the cut. He taps it and Omar gets the offer in his chat. While Omar's reading, you can still see a gap at four on the calendar. Now he types one word, yes. Chairside checks four again before it books him. That's Omar's receipt on the glasses and his appointment below Anna's.

**1:40 to 2:25**

Back in Anna's chat, she's asking about a beard trim at five. Look at the glasses while I add a block to the calendar. The card Karim is reading still says five is free. The block runs from five to five thirty. Now he taps to book. His glasses say nothing was sent. Anna's last message is still her question about the trim, and there's no beard trim alongside that block. Karim can see the next opening, five forty-five. He can offer it when he's ready.

**2:25 to 2:50**

I timed the same booking on my phone, from sending Anna's message to seeing Karim's confirmation with the appointment saved. It took {{phone_workflow_seconds}} seconds. With the glasses it took {{glasses_workflow_seconds}} seconds. From Karim's tap to the reply showing up in Anna's chat was {{tap_to_reply_seconds}} seconds.

**2:50 to 3:00**

Chairside lets Karim book a client without putting down the scissors. He approves every booking or offer. Chairside never stores the message text.

## Retake tips

- If a time differs, check the New York setting and the actual week view. Use the opening the card offers. For the planned take, clear only rehearsal bookings from the dedicated calendar and start fresh. `demo:reset` clears marked seed events and demo blocks. Bookings made by Anna and Omar survive it.
- Give Omar time to read the offer before sending "yes." The glasses briefly suppress repeated receipts for a request the owner just handled. Capture the receipt as it appears and hold that frame in the edit if needed.
- For Anna's beard trim, note the chat and calendar counts after her DM and the Busy block, immediately before the tap. Compare them with the counts after the tap. Keep both panes visible so the viewer can check that the tap added neither a message nor an appointment.
- If Calendar takes a moment to refresh, keep recording and hold the result. Take all timings from the uncut run and the phone stopwatch.
