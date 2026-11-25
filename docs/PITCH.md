# Chairside at Demo Day

## Live script

[ON SCREEN] Start on the title card. Bring up the G2 simulator on the left, the customer's Telegram thread at top right and Google Calendar at bottom right.

Everyone here built for traders. The people who need hands-free most are barbers. Picture Karim halfway through a haircut. Anna wants an appointment, and the clippers are still in his hand. Usually he'd have to put them down to look at his phone. With Chairside, Anna can get an answer while Karim stays with the person in the chair.

[ON SCREEN] Anna asks for a skin fade on Saturday 5 Dec at 3pm. Tap "Book & reply." Hold on her reply and her calendar event.

This is Anna's chat with Karim. She's writing to the same account she'd normally use. Karim connected a Telegram Business bot to his account and chose which chats it could read. His glasses show Anna's name, the skin fade she asked for, and room for the whole cut at three. A fade takes forty-five minutes, and Karim leaves a little time between clients. Chairside accounts for both when it checks the calendar.

I'll tap once. On Anna's screen, Karim has replied right under her question. On his calendar, the fade runs from three to three forty-five. Her first name and the appointment details go on the calendar. The shop server reads her message in memory and never saves the text.

[ON SCREEN] Omar asks for the same slot. Tap the offer for 16:00. Show the offer, Omar's "yes," the receipt and the new event.

Omar wants three as well. Anna's already in the book, so the first action Karim sees is an offer for four. I'll send it. Watch the calendar while Omar reads. Four is still open. If he writes "yes but five is better," Karim gets to look at that request. Here he just says "yes." Chairside checks four again, books the fade and confirms it with him. Karim already approved that time when he sent the offer.

[ON SCREEN] Anna asks for a beard trim at 17:00. Keep the free card visible, add the Busy block, then tap. Hold the thread and the refreshed card side by side.

Anna would also like a beard trim at five. That time was free when the card came up. I'll block it on Karim's calendar while he's still reading. Now I'll tap to book. Look at the last line in Anna's chat. It's still her question. There's no beard trim next to that block. Karim's glasses tell him nothing was sent and give him five forty-five to offer.

[ON SCREEN] Show the stopwatch comparison for the same booking, from Anna sending her DM to seeing her confirmation, with the event already saved.

On the phone, that booking took {{phone_workflow_seconds}} seconds. On G2 it took {{glasses_workflow_seconds}} seconds. Both clocks stopped when Anna could read her confirmation. Think about Karim's side of that exchange. On his phone he had to switch from the chat to the calendar and back. Here he could keep talking to his client. I'd start with solo barbers in Telegram-heavy markets like Dubai, where the next booking can come straight from a chat they already have.

## Q&A prep

### Why glasses and not a watch?

A watch asks Karim to turn his wrist and look down in the middle of a cut. G2 puts the requested time and the action in his line of sight, so he can approve the booking with a tap.

### Why not just send a booking link?

Anna already told Karim the service and time she wants. A link asks her to leave the chat and enter that information again. Chairside lets Karim answer her question where she asked it.

### Is this allowed by Telegram's terms?

Chairside uses Telegram's Business bot connection with the owner's permission, describes what it does and uses selected chats to handle bookings. Customer text stays on the shop server, and the owner approves the appointment details shared with Google Calendar. [Privacy and Telegram terms](PRIVACY.md)

### What about the 24-hour reply window?

The owner's bot can reply within 24 hours of the customer's last incoming message. After that, the card tells Karim he can't reply, which rules out reminders and bulk late notices through this connection.

### What happens if two people want the same slot?

Chairside processes each shop's bookings one at a time and checks availability again at approval or acceptance. After writing an event, it checks for an overlapping entry from another calendar user. If it finds one, it removes its own event and sends no confirmation.

### What's the business model?

Our hypothesis is that an independent shop would pay a subscription to handle Telegram bookings during appointments. We'd test that with solo barbers who already run their book through DMs.

### What's next?

We'd start with reminders for customers who opt in through the shop bot. We'd also like to test deposits, parse booking requests in more languages and try Chairside with other service workers, starting with stylists and nail techs.
