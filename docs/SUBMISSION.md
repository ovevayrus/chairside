# Heads Up: Even Realities Hackathon by TVM Ventures & Daos Hub

## Name

Chairside

## Tagline

Book a client from a Telegram DM with one tap on Even G2 glasses.

## Description

We designed Chairside for Karim, a solo barber in Dubai. When Anna messages him about a skin fade, he may already have someone in the chair. To book her on his phone, he has to put down the clippers, open their chat, check his calendar, enter the appointment and write back. Reading a watch means turning his wrist and looking down. His glasses put the time and the booking action in his line of sight.

Anna writes to Karim's usual Telegram account. He chooses which private chats his Telegram Business bot can read. When Anna asks for Saturday at three, Chairside reads her message in memory and checks his Google Calendar. One card on his Even G2 glasses shows her first name, the service, the date, the time and whether there's room for the whole cut. If it's free, he taps "Book & reply." Chairside checks again, writes the event and sends the confirmation from Karim's account. Anna sees his answer right below her question.

If Omar asks for the same time, Karim's card already has the next opening highlighted. One tap sends Omar that offer. His plain "yes" is enough to book the time Karim offered, after another calendar check. If an appointment lands on the calendar while Karim is reading a card, his tap sends nothing. He sees the new opening and decides whether to offer it.

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
- The owner approves every booking or offer. A customer can accept an approved offer without another tap. Chairside checks the event for overlaps before sending a booking confirmation.
- Shop-bot customers can erase their Chairside records with `/forget`. Business-chat customers can contact the owner. Owners can erase their shop's records with `/delete_my_data` in their private chat with the bot.

## Limits

- Telegram Business permits replies within 24 hours of the customer's last incoming message. Chairside doesn't send reminders or bulk late notices.
- The parser handles English booking requests. A missing day or time gives the owner a question to send.
- Cards appear while Chairside is open. We verified the glasses interface in the Even simulator. The system exit dialog and its cancel gesture still need a check on real G2 glasses.

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

- Repository {{repo_url}}
- Demo video {{video_url}}

## Human actions left

- [ ] Create the public GitHub repository and push Chairside.
- [ ] Record the demo and upload the video.
- [ ] Submit the BUIDL on DoraHacks.
- [ ] RSVP for Demo Day on Dec 3.
