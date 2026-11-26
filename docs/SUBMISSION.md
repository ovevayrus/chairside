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

The same interruption happens to stylists and nail techs who book through DMs. Their customers can keep using the chats they already have. The person doing the work gets to decide what goes on the calendar without typing a reply in front of a client.

## Tracks

- **Messaging & News.** A bot connected to Telegram Business reads the customer's DM and replies from the owner's account in the same thread.
- **AI Assistants & Work.** Google Calendar supplies availability and holds the appointment that the owner approves on G2.
- **Best Telegram integration (eligible).** A Telegram Business connected bot replies from the owner's own account in the customer's existing thread, and customers accept offers with a plain "yes" or an inline button.

## What's proven live

- Telegram granted the Business connection reply rights. A customer DM reached the server in 0.3 seconds, and a reply from the owner's account appeared in the customer's thread.
- An inline button on a Business message returned a callback. The bot also marked the incoming message as read.
- Google Calendar returned free/busy data and accepted an event with a deterministic ID. On a repeat insert, Chairside recognized its own event. It then deleted the test event.

## Privacy and safety

- The shop server parses customer messages with fixed rules. It never stores or logs the text or sends it to a third-party AI. A canary test checks normal and error logs, the database and its write-ahead log.
- Customer booking records contain only IDs, first name, service, times and statuses. Google Calendar gets the details needed for the appointment.
- The owner approves every booking or offer. A customer's "yes" accepts only the time the owner offered. Chairside checks the event for overlaps before sending a booking confirmation.
- Shop-bot customers can erase their Chairside records with `/forget`. Business-chat customers can contact the owner. Owners can erase their shop's records with `/delete_my_data` in their private chat with the bot.

## Limits

- Telegram Business permits replies within 24 hours of the customer's last incoming message. Chairside doesn't send reminders or bulk late notices.
- The parser handles English booking requests. A missing day or time gives the owner a question to send.
- Cards appear while Chairside is open. We verified the glasses app only in the Even simulator. The ring and the touchpads on the glasses' temples share the same SDK gestures (press, double press and swipe). We still need to test ring input on hardware and check the system exit dialog and its cancel gesture on real G2 glasses.

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
