# Architecture

Chairside has three parts: a glasses app that runs in the Even Realities phone app's WebView, a Node.js server that talks to Telegram and Google Calendar, and a small shared protocol package.

```
Customer's Telegram ──► Telegram Bot API (Business connection) ──► apps/server
                                                                     │  parse → free/busy → card
Owner's Google Calendar ◄──── service account ─────────────────────┤
                                                                     │  WebSocket (HTTP polling fallback)
Even G2 glasses ◄── BLE ── Even Realities app WebView: apps/glasses ◄┘
```

## Packages

- `packages/shared` — zod schemas and types for everything on the wire: cards, root state, live-channel frames, action requests and responses, pairing payloads. Display limits (32-character header, 3 lines of 40, at most 4 actions) are enforced here.
- `apps/server` — Node 24, TypeScript, Hono on `@hono/node-server`, `ws`, grammY, `node:sqlite`, the Google Calendar API, pino.
- `apps/glasses` — Vite and TypeScript on the Even Hub SDK 0.0.16. No framework; the glasses render SDK text and list containers, not HTML.

## Server modules (`apps/server/src`)

- `telegram/` — one `TelegramAdapter` interface with three implementations: `business` (Telegram Business connected bot; replies carry `business_connection_id`, so they come from the owner's own account), `shopbot` (customers DM the bot) and `fake` (tests and TEST MODE). Updates become small domain events; message text exists only in memory.
- `calendar/` — `CalendarAdapter` with a service-account `google` implementation and a `fake`. Free/busy fails closed on HTTP errors and on calendar-level errors. Event ids are deterministic (26 base32hex characters).
- `parse/` and `shop/` — a deterministic parser (chrono-node plus rules for services, AM/PM and closed days) and the shop config (services, hours, buffer, grid, reply templates).
- `slots/engine.ts` — a pure function that finds openings around busy time with buffer, grid and opening hours; property-tested.
- `requests/` — the inbound pipeline: per-chat 2.5 s debounce, parse, free/busy, proposals with the smart default first, and the card sent to the glasses. Edits, deletes, duplicate updates and the owner's own manual replies are handled.
- `actions/` — the executor behind `POST /api/actions`, offer acceptance and restart reconciliation.
- `live/` and `http/` — the per-shop live hub (sequenced frames, initial state on connect), REST routes, pairing routes and the `/ws` channel.
- `devices/` — pairing codes and device tokens (stored only as a peppered SHA-256 hash).
- `privacy/` — the redacting logger, `/forget` and `/delete_my_data`, and the bot's description.
- `dev/` — dev-only routes for TEST MODE (inject a message, auto-pair, block a slot). They return 404 unless `DEV_INJECT=1` outside production.

## The booking guarantee

For a new booking, the executor runs these steps under a per-shop lock when the owner taps.

1. Write an `actions` row first (unique per request, version and action), so a repeated or concurrent tap can't run twice.
2. Reject a stale card version.
3. Check the Telegram 24-hour reply window and the connection's rights.
4. Re-check free/busy for the slot plus buffer, failing closed on any error. If the slot is taken, send nothing and return a new card with the next opening.
5. Record the planned event id, then insert the event with a private marker. A 409 counts as ours only if the marker and interval match.
6. Look for an overlapping event from another calendar writer; if one appeared, delete ours and report the slot as taken.
7. Record `send_started`, then send the reply once, with an 8-second timeout and no automatic retry. A timeout becomes "reply status unknown" for the owner, never a resend.

On startup, interrupted actions are reconciled without sending anything: a calendar write without a reply becomes a "Send now?" card, and an interrupted send becomes "reply status unknown". A customer's "yes" to an offer goes through the same steps.

## Booking lifecycle

A new booking starts `active`. When the owner taps to move or shift it, Chairside rechecks availability and keeps the original appointment until it has written and verified the replacement. SQLite marks the old row `moved` and adds an `active` row linked by `replaced_booking_id`. A unique index allows one replacement per booking row. A later change applies to the current active row. If the requested slot is taken, the card can offer the next opening. When the customer says "yes", Chairside rechecks that slot and moves the same appointment.

Chairside removes an old event only if its ID, private booking marker and exact interval match. A move records `cleanup_pending` until this check and any needed deletion finish. If cleanup fails, the receipt flags the old slot and startup recovery retries it. A cancellation uses the same ownership check, marks the booking `cancelled`, and then confirms in Telegram. Startup recovery also finishes interrupted calendar changes and leaves any unsent confirmation for the owner to approve.

## Running-late impact

Chairside uses the first confirmed appointment in the chat that starts on the shop's local day and has yet to end. For "be there in 20", it counts from the current time and compares the result with the booked start. An early arrival leaves the message for the owner to handle. If the customer gives no time, the card offers to ask how late.

The server keeps the appointment's duration and checks the shifted time against shop hours and busy events. It leaves out the original event if its ownership details still match. To build the preview, the server looks at busy events starting at or after the original start and before local midnight. It picks the first one whose end plus buffer extends past the shifted start. The card compares that event's start with the shifted end plus buffer to show whether the shift fits or how many minutes it runs over.

The card shows a first name only when the event carries Chairside's private booking marker and uses the Chairside summary format. Other events appear as `busy`. A shift that ends after closing has its own message. If the shift cannot fit, the card can offer the next opening.

The server stores the preview in `requests.late_impact` so the card can show it again after a reconnect.

## Data

SQLite with write-ahead logging. Tables hold ids, first names, service ids, times, statuses and the Business connection's rights: `shops`, `devices`, `pair_codes`, `requests`, `request_messages`, `proposals`, `offers`, `actions`, `bookings`, `processed_updates`, `consents`. No table has a column for message text, and a canary test checks the database, its WAL and the logs.

## Glasses app (`apps/glasses/src`)

`app.ts` drives the screens (pair, root, card, receipt, status) from live frames; `net/` holds the WebSocket client with backoff and the HTTP polling fallback; `ui/` fits text using glyph widths measured in the simulator and drops glyphs the firmware font lacks; `input.ts` turns the SDK's tap, swipe, double-tap and long-press events into one small set of actions. The SDK gives the optional R1 ring the same press, double press and swipe gestures as the temple touchpads, so the owner can answer a card from the ring without touching the glasses. Chairside reacts to the gesture, not its source; the simulator sends every gesture as if from the glasses, so ring input itself is unverified until G2 hardware. A root double tap calls `shutDownPageContainer(1)` for the system exit dialog.

## Telegram limits that shaped the design

Business bots can only reply in chats with an incoming message in the last 24 hours, so Chairside sends no reminders or bulk notices. Reply keyboards and `web_app` buttons aren't allowed on Business messages; inline callback buttons are, and they were proven live.
