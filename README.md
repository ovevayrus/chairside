# Chairside

Chairside is a Telegram front desk for service workers who have a client in front of them and a booking request on their phone. A barber can read the request on Even G2 glasses and tap once to book it. The customer gets a reply from the barber's own Telegram account, in their usual thread, and the barber gets an appointment in Google Calendar.

## How it works

- The owner connects a Telegram Business bot to selected private chats and shares the shop's Google Calendar with Chairside.
- A customer DMs the owner. The shop server uses fixed rules to read the service, date and time, then checks the calendar.
- A card on the glasses shows who asked, what they want and whether the time is free. Tapping "Book & reply" checks the slot again, writes the event and sends the confirmation.
- If the slot is taken, the card highlights the next opening. The owner taps to offer it in the same thread.
- A plain "yes" accepts the owner's offer. Chairside checks availability again before booking and replying.
- If someone takes the slot while the owner is reading the card, the tap sends nothing. The card shows the next opening the owner can offer.

## Why it's safe

- The shop server reads customer message text in memory. It never stores or logs the text or sends it to any third-party AI. A canary test checks logs, the SQLite database and its write-ahead log.
- Customer booking records keep only IDs, first name, service, times and statuses. Calendar events contain the appointment details.
- The owner approves every booking or offer. A customer's acceptance applies only to the active offer in that chat.
- Chairside handles the shop's bookings one at a time and checks for overlaps after writing the event. If Telegram delivery is uncertain, the owner sees a notice to check the chat.
- Customers in shop-bot mode can use `/forget`. Business-chat customers can ask the owner about deletion. Owners can use `/delete_my_data` privately with the bot. Calendar events and Telegram chat history have their own deletion controls. [Privacy and Telegram terms](docs/PRIVACY.md)

## Status

**Live services.** We verified Telegram Business reply rights, receipt of a customer DM, a reply from the owner's account in that thread, an inline button callback and marking a message as read. On Google Calendar we checked free/busy, inserted an event with a deterministic ID, recognized the duplicate as ours and deleted the test event. [Live checks](docs/SPIKES.md)

**Even simulator.** With test adapters, we paired the glasses app, booked from a card and saw the receipt. When we blocked a slot before tapping, the customer's thread got no reply and the calendar got no new booking. The app also reconnected after a server restart. [Simulator run](docs/evidence/e2e-full.md)

## Limits

- Telegram Business allows replies for 24 hours after the customer's last incoming message. Chairside has no reminders or bulk late notices.
- Booking requests use English service names, dates and times. The glasses app must be open to show cards.
- The system exit dialog and its cancel gesture need verification on real G2 glasses.
- Telegram may ask the owner's account for Premium before it connects a bot through Telegram Business. Shop-bot mode (`TELEGRAM_MODE=bot`) works without it, but replies then come from the bot, not the owner.

## Setup

You need Node.js 24 or newer and the Even simulator and CLI:

```sh
npm install -g @evenrealities/evenhub-simulator @evenrealities/evenhub-cli
```

**TEST MODE, no accounts needed**

1. Clone the repository, `cd` into it and run `npm install`.
2. Run `npm run demo:local`. It starts the server with fake Telegram and Calendar adapters, the glasses app and the simulator, pairs the glasses and sends a few scripted customer DMs. Every card header says TEST. Act on each card in the simulator; Ctrl+C stops everything.

**With real Telegram and Google Calendar**

3. In @BotFather, create a bot with `/newbot`, then turn on Bot Settings → Secretary Mode (formerly Business Mode).
4. On the owner's Telegram account, open Settings → Telegram Business → Chatbots, add the bot and let it reply in the chats you choose.
5. In Google Cloud, enable the Google Calendar API, create a service account and save its JSON key as `apps/server/secrets/service-account.json`. In Google Calendar, share the shop's calendar with the service account's email address and choose "Make changes to events".
6. Copy `apps/server/.env.example` to `apps/server/.env` and fill in the bot token, the owner's numeric user id (from @userinfobot), the calendar id and a random `DEVICE_TOKEN_PEPPER`. Put the shop's services, hours and time zone in `config/shop.demo.json`.
7. Start the three parts, each in its own terminal: `npm run start:server`, `npm run start:glasses` and `npm run start:simulator`.
8. The glasses show a pairing code. From the owner's account, send `/pair CODE` to the bot.
9. From another Telegram account, message the owner, for example "Can I get a skin fade Saturday at 3pm?". The card appears on the glasses.

**On G2 glasses.** The network whitelist in `apps/glasses/app.json` allows only `http://localhost:8787`, which is enough for the simulator. A phone needs the server at an HTTPS address: set `VITE_API_BASE` to it, add it to the whitelist and run `npm run pack` to build `chairside.ehpk`. Chairside has not run on G2 hardware yet.

## Architecture

Three npm workspaces: `apps/glasses` (Vite and TypeScript on the Even Hub SDK 0.0.16), `apps/server` (Node 24, Hono, grammY, `node:sqlite` and the Google Calendar API) and `packages/shared` (the zod protocol both sides validate). The server turns a Telegram Business update into a card, pushes it to the glasses over WebSocket with HTTP polling as a fallback, and runs every tap through one executor that checks the calendar again before anything is sent. [Modules, the booking guarantee and the data model](docs/ARCHITECTURE.md)

## Testing

```sh
npm run typecheck                 # strict TypeScript, all workspaces and scripts
npm run lint
npm test                          # Vitest: server, glasses and shared packages
npm run build                     # all workspaces, then a scan for committed secrets
npm run e2e                       # full simulator run in TEST MODE -> docs/evidence/e2e-full.md
npm run e2e -- --smoke            # root-page checks (docs/SPIKES.md S3)
npm run e2e -- --idle             # 2-minute idle check
npm run demo:local -- --check     # headless TEST MODE check that saves a screenshot
npm run pack                      # chairside.ehpk with evenhub pack
```

The live checks need `apps/server/.env`. `npm run spike:telegram` waits for a customer DM, replies from the owner's account, sends an inline button and waits for its callback. `npm run spike:calendar` checks free/busy, inserts an event with a deterministic id, recognises the duplicate and deletes the event. Both write their results to [docs/SPIKES.md](docs/SPIKES.md).

## Pre-hackathon work and AI disclosure

No Chairside code, design or asset existed before the hackathon. The git history starts on November 24, 2026, and the only outside code is the open-source libraries listed in the `package.json` files.

We built Chairside with AI coding assistants. Claude Code planned the work, wrote and reviewed code, ran the tests and the simulator, and checked the documentation against the code and evidence. Codex implemented several features and drafted most of the prose. A person chose the idea, approved the plan, set up the Telegram and Google accounts and played the customer in the live checks.

Chairside itself uses no AI model. Booking requests are parsed with fixed rules, and customer messages never go to an AI service.

## License

[MIT](LICENSE)
