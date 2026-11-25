# API feature requests

Five things the platforms we built on were missing. Each one would make Chairside better for the person with their hands full.

1. **Even Hub: a one-line dashboard status for a plugin that isn't open.** A barber could see how many booking requests are waiting before opening Chairside.
2. **Even Hub: an attention-cue API.** G2 has no haptics; a quiet visual cue (for example a brief brightness pulse) would help the wearer notice a new request while another app is in front.
3. **Telegram Bot API: `web_app` buttons on Business messages.** A customer could open a small booking view from the owner's thread instead of only replying with text or pressing callback buttons.
4. **Telegram Bot API: customer-approved reminders for Business bots beyond the 24-hour reply window.** Business bots may only reply within 24 hours of the customer's last message, which rules out appointment reminders and "running late" notices through the owner's account.
5. **Google Calendar API: a conditional insert-if-free.** Checking free/busy and inserting are separate calls; an atomic "create this event only if the interval is still free" would remove the check-then-insert race with other calendar writers.
