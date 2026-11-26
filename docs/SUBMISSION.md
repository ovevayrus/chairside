# Heads Up: Even Realities Hackathon by TVM Ventures & Daos Hub

## Name

Chairside

## Tagline

Read a Telegram request on Even G2 glasses and book it with one press of the R1 ring.

## Description

David works alone in his Dubai barbershop. Alex messages him halfway through a haircut. To book Alex on his phone, David has to put down the clippers, open their chat, check his calendar, enter the appointment and write back. Reading a watch means turning his wrist and looking down. With Even G2 glasses, he can read Alex's request with the clippers still in hand. One press on his Even Realities R1 ring approves the time on the card. He can swipe to other times or "Not now". His phone stays in his pocket.

David chooses which private chats his Telegram Business bot can read. Alex writes to David's usual Telegram account, "Can I get a haircut Saturday 5 Dec at 3pm?" Chairside reads the message in memory and checks David's Google Calendar for the full 45 minutes. David's card shows "Alex · Haircut" and "Sat 5 Dec · 15:00 · ● free (45 min)". With "Book & reply" highlighted, David presses the ring once. Chairside checks again and adds "Chairside · Alex · Haircut" from 15:00 to 15:45. Alex sees the confirmation from David's account right under his question.

James asks for a skin fade at 3pm. Alex has that slot, so David's card highlights "Offer Sat 5 Dec 16:00", the next opening that fits. One press sends the offer from David's account. James types "yes" on his own phone. Chairside checks 16:00 again, books it and confirms in James's chat. David's glasses show "James accepted · Booked" without another press.

Alex returns to his chat with David and asks, "Can you also do a beard trim Saturday 5 Dec at 5pm?" The card shows 17:00 free. While David reads it, a 30-minute "Busy" block appears on his calendar at that time. He presses to book. Chairside checks again, sends Alex no message and adds no event. His beard-trim question is still the last message, below his haircut question and David's confirmation. David sees "Just taken · nothing sent" and can offer 17:45.

"Can I come at 4 instead?" brings up WANTS TO MOVE. Move & reply checks the new time again, books it before freeing the old slot and confirms in the chat. If the time is taken, David can offer the next opening and the customer's "yes" moves the same appointment. "I need to cancel" brings up WANTS TO CANCEL. Cancel & reply removes only Chairside's event and confirms in the chat. RUNNING LATE shows whether a delay fits before the next calendar event. David can approve the shift if it fits or offer another time.

## Tracks

- **Messaging & News.** A bot connected to Telegram Business reads the customer's DM and replies from the owner's account in the same thread.
- **AI Assistants & Work.** Google Calendar supplies availability and holds the appointment that the owner approves on G2.
- **Best Telegram integration (eligible).** A Telegram Business connected bot replies from the owner's own account in the customer's existing thread, and customers accept offers with a plain "yes" or an inline button.

## What's proven live

The live run used the Even simulator with real Telegram Business and Google Calendar. The owner booked an appointment, sent an offer the customer accepted with "yes", and saw the card update after a slot was taken while he was reading it. The run also covered pairing and reconnecting. [Live run](evidence/live-smoke.md)

- Telegram granted the Business connection reply rights. A customer DM reached the server in 0.3 seconds, and a reply from the owner's account appeared in the customer's thread.
- An inline button on a Business message returned a callback. The bot also marked the incoming message as read.
- Google Calendar returned free/busy data and accepted an event with a deterministic ID. On a repeat insert, Chairside recognized its own event. It then deleted the test event.

## Verified in the simulator

These changes passed automated tests and an Even simulator run with test stand-ins for Telegram and Google Calendar. They still need a run with real accounts. [Simulator run, shots 15-20](evidence/e2e-full.md)

- Move & reply replaced the 15:00 booking with a 16:00 booking and sent a confirmation.
- A 15-minute delay fit before the next appointment. The shift moved the booking to 16:15 and sent a confirmation.
- Cancel & reply removed the 16:15 booking and confirmed in the chat.

## Privacy and safety

- The shop server parses customer messages with fixed rules. It never stores or logs the text or sends it to a third-party AI. A canary test checks normal and error logs, the database and its write-ahead log.
- Customer booking records contain only IDs, first name, service, times and statuses. Google Calendar gets the details needed for the appointment.
- The owner approves bookings, changes and offers from the card. A customer's "yes" accepts only the time the owner offered. Chairside checks the event for overlaps before sending a booking confirmation.
- Shop-bot customers can erase their Chairside records with `/forget`. Business-chat customers can contact the owner. Owners can erase their shop's records with `/delete_my_data` in their private chat with the bot.

## Limits

- Telegram Business permits replies within 24 hours of the customer's last incoming message. Chairside doesn't send reminders or bulk late notices.
- The parser handles English booking requests. A missing day or time gives the owner a question to send.
- Cards appear while Chairside is open. We verified the glasses app only in the Even simulator. The ring and the touchpads on the glasses' temples share the same SDK gestures (press, double press and swipe). We still need to test ring input on hardware and check the system exit dialog and its cancel gesture on real G2 glasses.

### Next step for shops with several barbers

For a shop with two or three barbers sharing a Telegram account and calendar today, we'd keep the shop's account and list each barber and their calendar in the shop configuration. Each barber would pair their own glasses. A request for an appointment "with Sam" would go to Sam. If the customer doesn't name a barber, the request would go to one who's free at that time. The card would say "free with Sam", the booking would go on Sam's calendar, and the reply from the shop's account would name Sam.

## Who uses it and who pays

The barber, stylist or nail tech wears G2 through the workday and handles DMs with a client in the chair. Customers keep using their usual chats, and the person doing the work decides what goes on the calendar. Our hypothesis is that the shop owner would pay a monthly subscription per chair. We'd test that with solo barbers first.

## Built with

The glasses app uses TypeScript, Vite and the Even Hub SDK. A Node.js server uses Hono, grammY for the Telegram Bot API, the Google Calendar API with a service account, and SQLite. It delivers card updates over WebSocket with an HTTP polling fallback.

We started with open-source libraries and no Chairside code from before Nov 23. We used Claude Code and Codex as AI coding assistants during the hackathon.

## API feature requests

1. Give an Even Hub plugin a one-line dashboard status while it is closed. A barber could see how many requests are waiting before opening Chairside.
2. Give Even Hub apps an attention-cue API. G2 has no haptics, and a quiet visual cue could help the wearer notice a new request.
3. Support Telegram `web_app` buttons on Business messages so a customer could open a booking view from the owner's thread.
4. Let customers authorize appointment reminders from a Telegram Business bot beyond the 24-hour reply window.
5. Give Google Calendar a conditional insert-if-free operation. The calendar could check the interval and create the event in the same operation.

## Links

- Repository: https://github.com/ovevayrus/chairside
- Demo video: https://youtu.be/x62mesv54SA

## Human actions left

- [x] Create the public GitHub repository and push Chairside.
- [x] Record the demo and upload the video.
- [ ] Submit the BUIDL on DoraHacks.
- [ ] RSVP for Demo Day on Dec 3.
