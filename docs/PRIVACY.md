# Chairside privacy

## What happens to a booking message?

In Telegram Business, the shop owner chooses which private chats Chairside can access. Telegram delivers messages from those chats to the shop's Chairside server. In shop-bot mode, customers write directly to the bot instead. Telegram keeps the conversation in the participants' chat history.

The server reads incoming text or captions to recognise the service, day and time a customer wants. It groups messages that arrive close together and parses them in memory after a 2.5-second pause. Chairside never writes the original message text to its database or logs, or sends it to Google or an AI service.

The owner sees a booking card on their glasses. The server checks availability on the owner's shared Google Calendar. When a booking goes ahead, the event contains the customer's Telegram first name, service, start and end times, and internal booking identifiers. Other appointments appear as “Busy” on the glasses. Booking replies and offers require the owner's approval on the glasses. If a customer accepts an approved offer, Chairside can confirm it without another tap.

## What does the server keep, and for how long?

The shop's SQLite database keeps the customer's first name, chat and message identifiers, service, requested and offered times, and the status of requests, bookings and replies. It records calendar event identifiers and action results so a retried tap can return the previous result. These records have no automatic expiry. They stay until deleted.

The database also holds shop settings, the owner's Telegram identifier, Business connection permissions, device identifiers, token hashes and pairing records. A new pairing code has a ten-minute window for the owner to use it. Unclaimed codes have no shop identifier and can remain in the database after expiry. Telegram update numbers and receipt times are kept separately to prevent repeated processing. These entries carry no customer, chat or shop identifier.

## How do I delete data or disconnect?

- If you messaged the shop bot directly, send **`/forget`** in that same private chat. It deletes your requests and their related records for that shop and replies with a confirmation. If you booked through the owner's Business chat, contact the owner about deletion.
- If you own the shop, send **`/delete_my_data`** in your private chat with the bot. It deletes the shop's database records, including requests, bookings, offers, consent records, paired devices and pairing codes linked to the shop. The bot confirms in that chat. Restarting a server that still has the shop configured creates a fresh shop record.
- To erase chat history, use Telegram's chat controls. Calendar events belong to the owner and stay on their calendar after either command. The owner can delete them in Google Calendar.
- To stop future access, disconnect Chairside in the owner's Telegram Business chatbot settings and remove Chairside's service account from the calendar's sharing settings. Use the owner command to erase records already held on the server. [Telegram Business bots](https://core.telegram.org/bots/features#business-bots) · [Google Calendar sharing](https://support.google.com/calendar/answer/37082?hl=en)

## Even glasses permission

The glasses app requests one Even permission, **network**. It connects to the shop's Chairside server to pair the glasses, show booking cards and the schedule, and submit the owner's taps. The Even app on the phone keeps the glasses' pairing token in local storage.

## Telegram's developer terms

Chairside follows the data minimisation principle in section 4.3 by keeping only the booking and operational fields described above. It does not collect chat datasets, train models or build AI products from messages. For Telegram Business, section 5.4(i) requires an accurate bot description, (iii) limits use of chat data to providing the chatbot service, and (iv) requires user authorisation for disclosure to third parties. The owner chooses the calendar to share and approves the booking details used there. The message itself is processed on the shop's server. [Telegram Bot Platform Developer Terms](https://telegram.org/tos/bot-developers)
