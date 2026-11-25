// Pure helpers for `npm run smoke:live`: arguments, the booking day, what the
// customers type, and the evidence report. No I/O here, so it is unit-tested.
import { DateTime } from 'luxon'

export const DEFAULTS = Object.freeze({
  day: undefined,
  pauseS: 3,
  waitMin: 10,
  finalDm: true,
  keepDemo: false,
})

const USAGE =
  'usage: npm run smoke:live [-- --day yyyy-MM-dd] [--pause seconds] [--wait minutes] [--no-final-dm] [--keep-demo]'

function number(name, text, { allowZero }) {
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} number, got ${text}\n${USAGE}`,
    )
  }
  return value
}

export function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${arg} needs a value\n${USAGE}`)
      return value
    }
    switch (arg) {
      case '--day': {
        const value = next()
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !DateTime.fromISO(value).isValid
        ) {
          throw new Error(`--day must be yyyy-MM-dd, got ${value}\n${USAGE}`)
        }
        options.day = value
        break
      }
      case '--pause':
        options.pauseS = number(arg, next(), { allowZero: true })
        break
      case '--wait':
        options.waitMin = number(arg, next(), { allowZero: false })
        break
      case '--no-final-dm':
        options.finalDm = false
        break
      case '--keep-demo':
        options.keepDemo = true
        break
      default:
        throw new Error(`unknown argument ${arg}\n${USAGE}`)
    }
  }
  return options
}

/** The first Saturday at least two days ahead in the shop's zone, as yyyy-MM-dd. */
export function defaultDay(nowMs, zone) {
  let day = DateTime.fromMillis(nowMs, { zone }).startOf('day').plus({ days: 2 })
  while (day.weekday !== 6) day = day.plus({ days: 1 })
  return day.toISODate()
}

/** "Saturday 5 Dec": how the demo customers name the day. */
export function spokenDay(isoDay) {
  return DateTime.fromISO(isoDay).setLocale('en-US').toFormat('cccc d LLL')
}

/**
 * What the customers send, in order (docs/DEMO_SCRIPT.md tells the same
 * story): Alex's haircut, James's skin fade and "yes", Alex's beard trim,
 * and James's message after the reconnect.
 */
export function customerLines(isoDay) {
  const day = spokenDay(isoDay)
  return {
    haircut: `Can I get a haircut ${day} at 3pm?`,
    skinFade: `Can I get a skin fade ${day} at 3pm?`,
    yes: 'yes',
    beardTrim: `Can you also do a beard trim ${day} at 5pm?`,
    final: `Could I come in for a haircut ${day} at 11am?`,
  }
}

/**
 * Removes what must not reach public evidence from free text: bot tokens (also
 * inside a /bot<token>/ URL), email addresses, plain or URL-encoded (calendar
 * ids look like them), and 7+ digit numbers (Telegram user and chat ids).
 */
export function redact(text) {
  return text
    .replace(/\d{6,}:[\w-]{30,}/g, '[token]')
    .replace(/[\w.+-]+(?:@|%40)[\w-]+(?:\.[\w-]+)+/gi, '[email]')
    .replace(/-?\b\d{7,}\b/g, '[id]')
}

/** Seconds from one epoch-ms instant to another, to 2 decimals; undefined if either is missing. */
export function secondsBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return undefined
  return Math.round((toMs - fromMs) / 10) / 100
}

/** A console entry's time: its own timestamp when it is sane, else when the runner first saw it. */
export function entryTime(entry) {
  const raw = entry.ts
  let ts = Number.NaN
  if (typeof raw === 'number') ts = raw < 1e12 ? raw * 1000 : raw
  else if (typeof raw === 'string') ts = Date.parse(raw)
  if (entry.seenAt === undefined) return Number.isFinite(ts) ? ts : Number.NaN
  return Number.isFinite(ts) && Math.abs(ts - entry.seenAt) < 5000
    ? ts
    : entry.seenAt
}

const show = (value, unit = '') =>
  value === undefined || value === null || Number.isNaN(value)
    ? 'not reached'
    : `${value}${unit}`

const code = (text) => `\`${text}\``

function list(values) {
  return values?.length ? values.map((value) => code(value)).join(', ') : 'none'
}

/** The Markdown evidence file. `r` may be partial: a failed run reports how far it got. */
export function renderReport(r) {
  const m1 = r.moment1 ?? {}
  const m2 = r.moment2 ?? {}
  const m3 = r.moment3 ?? {}
  const pair = r.pairing ?? {}
  const rc = r.reconnect ?? {}
  const lines = [
    '# Live end-to-end smoke (US-015)',
    '',
    `Run ${r.startedAt} to ${r.finishedAt ?? 'interrupted'} by ${code('npm run smoke:live')} (${code('scripts/smoke-live.mjs')}): real Telegram (${code(r.env?.telegramMode ?? '?')} mode) and real Google Calendar; the glasses are the Even Hub simulator, not G2 hardware. Shop config ${code(r.env?.shopConfig ?? '?')} (${r.env?.timezone ?? '?'}), booking day ${r.env?.day ?? '?'} (${r.env?.spokenDay ?? '?'}). Node ${r.env?.node ?? '?'} on ${r.env?.platform ?? '?'}.`,
    '',
    `Result: **${r.ok ? 'PASS' : `FAIL${r.error ? `: ${r.error}` : ''}`}**`,
    '',
    'Recorded: Telegram message ids, Chairside request and action ids, calendar event ids, times, counts and statuses. Not recorded: message text, names, Telegram user or chat ids. Screenshots are taken only when the customer accounts are named Alex or James.',
    '',
    '## Timings (Moment 1)',
    '',
    '| Interval | Seconds |',
    '| --- | --- |',
    `| Customer's DM (Telegram timestamp) to the card on the glasses. Telegram timestamps are whole seconds, so this reads up to 1 s high; it includes the 2.5 s wait for follow-up messages | ${show(m1.telegramToCardS)} |`,
    `| DM received by the server to the card on the glasses | ${show(m1.receivedToCardS)} |`,
    `| Tap to the server holding the action | ${show(m1.tapToServerS)} |`,
    `| Tap to the reply sent (Telegram confirmed it) | ${show(m1.tapToReplyS)} |`,
    `| Tap to the receipt on the glasses | ${show(m1.tapToReceiptS)} |`,
    `| The whole glasses workflow: DM (Telegram timestamp) to the reply sent, with the card held ${r.env?.pauseS ?? '?'} s before the tap as the owner's reading time | ${show(m1.dmToReplyS)} |`,
    '',
    "Server-side times come from the server's own records. Those records do not tie an update to a chat, so a message from another chat at the same moment could shift the received times.",
    '',
    '## Pairing from scratch',
    '',
    `- Simulator launch to the app ready: ${show(pair.readyS, ' s')}; to a pairing code on the glasses: ${show(pair.launchToCodeS, ' s')}.`,
    `- Code shown to paired (the owner typed ${code('/pair CODE')} in the bot chat): ${show(pair.codeToPairedS, ' s')}.`,
    `- Paired to the live channel: ${show(pair.pairedToLiveS, ' s')}.`,
    '',
    '## Moment 1: one tap books it',
    '',
    `- DM message id(s): ${list(m1.dmMessageIds)}; request ${show(m1.requestId && code(m1.requestId))}; parsed ${show(m1.parsed)}.`,
    `- Tap result: ${show(m1.status)}. Reply message id ${show(m1.replyMessageId)}; action ${show(m1.actionId && code(m1.actionId))}.`,
    `- Calendar event ${show(m1.eventId && code(m1.eventId))} at ${show(m1.eventLocal)}, read back from Google Calendar: ${show(m1.eventVerified)}.`,
    '',
    '## Moment 2: slot taken, offer, "yes"',
    '',
    `- DM message id(s): ${list(m2.dmMessageIds)}; request ${show(m2.requestId && code(m2.requestId))}; DM to card ${show(m2.telegramToCardS, ' s')} (Telegram timestamp).`,
    `- Offer for ${show(m2.offerLocal)}: message id ${show(m2.offerMessageId)}; offer status after the tap ${show(m2.offerStatusAfterTap)}.`,
    `- The customer typed "yes" (message id(s) ${list(m2.yesMessageIds)}); booking confirmation message id ${show(m2.bookingMessageId)}; offer status ${show(m2.offerStatus)}.`,
    `- Calendar event ${show(m2.eventId && code(m2.eventId))} at ${show(m2.eventLocal)}, read back from Google Calendar: ${show(m2.eventVerified)}. "Yes" received to the booking confirmed: ${show(m2.yesToBookedS, ' s')}.`,
    '',
    '## Moment 3: the slot is taken while the card is on screen',
    '',
    `- Request ${show(m3.requestId && code(m3.requestId))}; the card showed ${show(m3.slotLocal)} free.`,
    `- Foreign block ${show(m3.blockId && code(m3.blockId))} inserted at ${show(m3.blockLocal)} before the tap.`,
    `- Tap result: ${show(m3.status)}; the card came back as version ${show(m3.versionAfter)}, offering ${show(m3.nextLocal)}.`,
    '',
    '| Count | Before the tap | After the tap |',
    '| --- | --- | --- |',
    `| Messages below the customer's question in her thread (operator count from the screen; the Bot API cannot read chat history) | ${show(m3.before?.thread)} | ${show(m3.after?.thread)} |`,
    `| Messages Chairside has sent in this customer's thread (server records) | ${show(m3.before?.sent)} | ${show(m3.after?.sent)} |`,
    `| Events on ${r.env?.day ?? 'the day'} in Google Calendar, excluding the block | ${show(m3.before?.events)} | ${show(m3.after?.events)} |`,
    '',
    '## Reconnect',
    '',
    `- Server stopped at ${show(rc.stoppedAt)}; the glasses showed the status screen after ${show(rc.statusS, ' s')}.`,
    `- Server restarted at ${show(rc.restartedAt)} and listening after ${show(rc.listeningS, ' s')}; the glasses were back on root ${show(rc.backS, ' s')} after the restart (link states: ${rc.links?.length ? rc.links.join(', ') : 'none logged'}). No pairing asked: ${show(rc.noRepair)}.`,
    `- A new DM after the restart opened a card: ${show(rc.finalCard)}.`,
    '',
    '## Clean start',
    '',
    `- ${code('demo:reset')} equivalent removed ${show(r.clean?.removed)} demo event(s); seeded: ${r.clean?.seeded?.length ? r.clean.seeded.map((s) => `${code(s.id)} ${s.local}`).join('; ') : 'none'}.`,
    `- Cleanup at the end: ${show(r.cleanup)}.`,
    '',
    '## Checks',
    '',
    ...(r.checks?.length
      ? r.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'}: ${c.label}`)
      : ['- none ran']),
    '',
    '## Screenshots',
    '',
    ...(r.shots?.length
      ? r.shots.map((s) => `- ${code(s.path)}: ${s.caption}`)
      : ['- none']),
    '',
    '## Timeline (UTC, for cutting the screen recording)',
    '',
    ...(r.timeline?.length
      ? r.timeline.map((t) => `- ${t.at} ${t.text}`)
      : ['- empty']),
    '',
  ]
  return lines.join('\n')
}
