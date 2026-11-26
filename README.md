# Chairside

Chairside is a Telegram front desk for service workers who have a client in front of them. A barber can read booking requests and changes on Even G2 glasses and act with a tap. The customer gets a reply from the barber's own Telegram account in their usual thread, and Chairside updates Google Calendar.

## What Chairside handles

The owner connects a Telegram Business bot to selected private chats and shares the shop's Google Calendar. Chairside reads incoming requests with fixed rules and shows them on the glasses.

- Book a free slot. "Book & reply" checks the calendar again, writes the event and confirms in the chat.
- Offer the next opening. A customer's "yes" accepts the offer, and Chairside checks the slot again before booking.
- Catch a slot taken while the owner is reading the card. The tap sends nothing and the card shows the next opening to offer.
- Move a booking when a customer says "Can I come at 4 instead?" "Move & reply" rechecks the slot and writes the new event before removing the old one. If the slot is taken, the owner can offer the next opening and the customer's "yes" moves the same booking.
- Cancel a booking when a customer says "I need to cancel." "Cancel & reply" removes only Chairside's event and confirms in the chat.
- Handle late arrivals. "Running 15 min late" brings up the proposed start and whether it fits before the next event. The owner can shift the booking, offer the next opening if it clashes, or ask how late when the customer gives no time.

## Why it's safe

- The shop server reads customer message text in memory. It never stores or logs the text or sends it to any third-party AI. A canary test checks logs, the SQLite database and its write-ahead log.
- Customer booking records keep only IDs, first name, service, times and statuses. Calendar events contain the appointment details.
- The owner chooses the action on the card. A customer's acceptance applies only to the active offer in that chat.
- Chairside handles the shop's bookings one at a time and checks for overlaps after writing the event. If Telegram delivery is uncertain, the owner sees a notice to check the chat.
- Customers in shop-bot mode can use `/forget`. Business-chat customers can ask the owner about deletion. Owners can use `/delete_my_data` privately with the bot. Calendar events and Telegram chat history have their own deletion controls. [Privacy and Telegram terms](docs/PRIVACY.md)

## What's verified where

The live run used real Telegram Business and Google Calendar with the Even simulator. It covered booking, offering an opening and accepting it with "yes," a slot taken while the owner was reading, pairing and reconnecting. [Live run](docs/evidence/live-smoke.md)

Moves, cancellations and late arrivals passed automated tests and a separate Even simulator run with test stand-ins for Telegram and Google Calendar. Those three flows still need a run with real accounts. [Simulator run](docs/evidence/e2e-full.md)

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
