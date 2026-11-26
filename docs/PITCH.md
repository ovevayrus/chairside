# Chairside at Demo Day

## Live script

[ON SCREEN] Start on the title card. Bring up the G2 simulator on the left, the customer's Telegram thread at top right and Google Calendar at bottom right.

David works alone in his barbershop in Dubai. He's halfway through a haircut, clippers in hand, when Alex messages him. With Chairside, David never has to touch his phone. He reads each request on his Even G2 glasses and answers with a press of his Even Realities R1 ring. We're showing his view in the Even simulator.

[ON SCREEN] Alex asks, "Can I get a haircut Saturday 5 Dec at 3pm?" Show "Alex · Haircut" and "Sat 5 Dec · 15:00 · ● free (45 min)". After the press, hold on his chat and the calendar event "Chairside · Alex · Haircut" from 15:00 to 15:45.

In their usual Telegram chat, Alex asks for a haircut at three on Saturday. David's connected a Telegram Business bot and chosen which chats it can read. Chairside reads the message in memory on the shop server. Simple rules built from David's own service names pick out the service, day and time. No AI ever sees the message, and Chairside never stores or logs the text.

Chairside checks David's Google Calendar for the full forty-five minutes. "Book & reply" is already highlighted. David can swipe the ring for other times or "Not now". Three works, so he presses once. Alex's haircut goes on the calendar. Right under his question is the confirmation from David's own Telegram account.

[ON SCREEN] James asks for a skin fade at 3pm. Show "Offer Sat 5 Dec 16:00", then James's chat, the new event and David's glasses.

James wants a skin fade at three, too. Alex finishes at quarter to four and David leaves five minutes between clients, so the card highlights four, the next opening that fits. David presses to send the offer. James types "yes" on his own phone. Chairside checks four again before it books the fade and confirms in James's chat. David sees "James accepted · Booked" on his glasses without pressing again.

[ON SCREEN] Back in his chat with David, Alex asks, "Can you also do a beard trim Saturday 5 Dec at 5pm?" With the card showing 17:00 free, add a 30-minute "Busy" block at 17:00. Simulate the ring press. Hold Alex's chat and the refreshed card side by side. Keep his haircut question and David's confirmation visible above the beard-trim request.

Alex asks for a beard trim at five. David's card shows it's free. What if someone takes that slot while David's reading? I'll mark five to five thirty as Busy on his calendar. When David presses to book, Chairside sees the block. Alex's chat still ends with his question, and there's no beard trim on the calendar. The card says "Just taken · nothing sent" and gives him five forty-five to offer. A double press takes David back to his home screen.

[ON SCREEN] Double press the ring to return to David's home screen. Hold there with both bookings visible on the calendar.

That's three requests, and David never touched his phone. Call it about a minute saved per booking. But the real win is that his hands never leave his work. I'd start with solo barbers in Telegram-heavy markets like Dubai, where the next booking can come straight from a chat they already have.

## Q&A prep

### Why glasses and not a watch?

A watch asks David to turn his wrist and look down in the middle of a haircut. G2 puts the time in his line of sight, and he can approve it with his thumb on the ring. The R1 and the glasses' temple touchpads share the SDK's press, double press and swipe gestures. We've verified the app in the Even simulator only. We still need to check ring input, the system exit dialog and its cancel gesture on real G2 glasses.

### Why not just send a booking link?

Alex already told David the service and time he wants. A link asks him to leave the chat and enter that information again. Chairside lets David answer right there in Alex's chat.

### Is this allowed by Telegram's terms?

Chairside uses Telegram's Business bot connection with the owner's permission, describes what it does and uses selected chats to handle bookings. Customer text stays on the shop server, and the owner approves the appointment details shared with Google Calendar. [Privacy and Telegram terms](PRIVACY.md)

### What about the 24-hour reply window?

The owner's bot can reply within 24 hours of the customer's last incoming message. After that, the card tells David he can't reply, which rules out reminders and bulk late notices through this connection.

### What happens if two people want the same slot?

Chairside processes each shop's bookings one at a time and checks availability again at approval or acceptance. After writing an event, it checks for an overlapping entry from another calendar user. If it finds one, it removes its own event and sends no confirmation.

### What's the business model?

Our hypothesis is that an independent shop would pay a subscription to handle Telegram bookings during appointments. We'd test that with solo barbers who already run their book through DMs.

### What's next?

We'd start with reminders for customers who opt in through the shop bot. We'd also like to test deposits, parse booking requests in more languages and try Chairside with other service workers, starting with stylists and nail techs.
