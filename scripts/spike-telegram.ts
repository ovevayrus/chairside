/**
 * Live spike S1: proves the Telegram Business loop against the real Bot API with the same
 * BusinessTelegramAdapter the server uses.
 *
 *   npx tsx scripts/spike-telegram.ts
 *
 * Needs TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_USER_ID (apps/server/.env is loaded when it
 * exists). Long-polls for up to 5 minutes while the operator follows the prompts, then
 * appends a dated "S1 Telegram (live run)" block under "## S1 Telegram" in docs/SPIKES.md.
 * Only ids, rights and ISO times are printed or written: never message text, never the token.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { BusinessTelegramAdapter } from '../apps/server/src/telegram/business.js'
import {
  normalizeConnection,
  type CallbackEvent,
  type ChatMessageEvent,
  type ConnectionEvent,
} from '../apps/server/src/telegram/events.js'

const RUN_MS = 5 * 60_000
const CALLBACK_WAIT_MS = 2 * 60_000
const REPLY_TEXT = 'Chairside spike test reply'
const BUTTON_TEXT = 'Chairside spike: tap Test to check inline buttons'
const ENV_PATH = fileURLToPath(new URL('../apps/server/.env', import.meta.url))
const SPIKES_PATH = fileURLToPath(new URL('../docs/SPIKES.md', import.meta.url))

type Status = 'PASS' | 'FAIL' | 'SKIP'
interface Check {
  label: string
  status: Status
  evidence: string
}
type Connection = ReturnType<typeof normalizeConnection>

const iso = () => new Date().toISOString()

/** Inserts the block at the end of the "## S1 Telegram" section (adds the section if missing). */
export function insertUnderS1(doc: string, block: string): string {
  const heading = /^## S1 Telegram\b.*$/m.exec(doc)
  if (!heading) return `${doc.trimEnd()}\n\n## S1 Telegram\n\n${block}\n`
  const bodyStart = heading.index + heading[0].length
  const next = doc.slice(bodyStart).search(/^## /m)
  const end = next === -1 ? doc.length : bodyStart + next
  const before = doc.slice(0, end).trimEnd()
  const after = doc.slice(end)
  return after ? `${before}\n\n${block}\n\n${after}` : `${before}\n\n${block}\n`
}

async function waitFor<T>(
  read: () => T | undefined,
  until: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  while (read() === undefined && Date.now() < until && !signal.aborted) {
    await sleep(250)
  }
  return read()
}

async function main(): Promise<number> {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH)
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ''
  const ownerRaw = process.env.OWNER_TELEGRAM_USER_ID?.trim() ?? ''
  const missing = [
    ...(token
      ? []
      : ['TELEGRAM_BOT_TOKEN=<the bot token from @BotFather>   (not set)']),
    ...(/^\d+$/.test(ownerRaw)
      ? []
      : [
          `OWNER_TELEGRAM_USER_ID=<the owner account's numeric user id, from @userinfobot>   (${ownerRaw ? 'not a number' : 'not set'})`,
        ]),
  ]
  if (missing.length) {
    console.error(
      [
        'Spike S1 cannot start. Set these in apps/server/.env yourself (never in chat or git):',
        ...missing.map((line) => `  ${line}`),
        'Then run again: npx tsx scripts/spike-telegram.ts',
      ].join('\n'),
    )
    return 1
  }
  const ownerUserId = Number(ownerRaw)
  const explain = (error: unknown) =>
    (error instanceof Error ? error.message : String(error))
      .replaceAll(token, '<token>')
      .replaceAll('|', '/')

  const startedAt = iso()
  const deadline = Date.now() + RUN_MS
  const run = new AbortController()
  const runTimer = setTimeout(() => run.abort(), RUN_MS)
  const interrupt = () => {
    console.log('\nInterrupted: finishing early and recording what was seen.')
    run.abort()
  }
  process.once('SIGINT', interrupt)

  // A fresh nonce per run, so a late tap on an older spike button cannot pass check (d).
  const callbackData = `spike:${randomBytes(4).toString('hex')}`
  const adapter = new BusinessTelegramAdapter({ token, ownerUserId })
  const seen: {
    connection?: { event: ConnectionEvent; at: string }
    incoming?: { event: ChatMessageEvent; at: string }
    callback?: { event: CallbackEvent; at: string }
    botEchoes: Set<number>
  } = { botEchoes: new Set() }

  adapter.onEvent((event) => {
    if (event.type === 'connection') {
      seen.connection = { event, at: iso() }
      console.log(
        `  <- business_connection update ${event.updateId}: enabled=${event.isEnabled}, can_reply=${event.rights.canReply}`,
      )
    } else if (event.type === 'message' && event.connectionId) {
      if (event.direction === 'incoming' && !seen.incoming) {
        seen.incoming = { event, at: iso() }
        console.log(
          `  <- business_message ${event.messageId} from the customer (update ${event.updateId})`,
        )
      } else if (event.direction === 'outgoing_bot') {
        seen.botEchoes.add(event.messageId)
      }
    } else if (
      event.type === 'callback' &&
      event.data === callbackData &&
      !seen.callback
    ) {
      seen.callback = { event, at: iso() }
      console.log(`  <- callback_query on message ${event.messageId}`)
    }
  })

  let pollingError: string | undefined
  const polling = adapter
    .start(() => {
      console.log(`Polling as @${adapter.bot.botInfo.username}.`)
    })
    .catch((error: unknown) => {
      pollingError = explain(error)
      console.error(`Polling stopped: ${pollingError}`)
      run.abort()
    })

  console.log(
    [
      'Chairside spike S1 (Telegram Business). Runs up to 5 minutes; Ctrl+C finishes early.',
      `1. Owner account: Telegram > Settings > Telegram Business > Chatbots: connect this bot and allow it to reply.`,
      "2. Now send 'hi' from the customer account to the owner account. Waiting...",
    ].join('\n'),
  )

  // (b) then (a): the business_connection update only arrives when the owner connects or
  // changes the bot, so the connection is also fetched with getBusinessConnection.
  const incoming = await waitFor(() => seen.incoming, deadline, run.signal)
  const connectionId =
    incoming?.event.connectionId ?? seen.connection?.event.connectionId
  let connection: Connection | undefined = seen.connection?.event
  let connectionSource = seen.connection
    ? `business_connection update ${seen.connection.event.updateId} at ${seen.connection.at}`
    : 'no business_connection update during the run'
  let rightNames = 'unknown'
  if (connectionId) {
    try {
      const raw = await adapter.getConnection(connectionId)
      connection = normalizeConnection(raw)
      rightNames =
        Object.keys(raw.rights ?? {})
          .sort()
          .join(', ') || 'none'
      connectionSource += `; getBusinessConnection at ${iso()}`
    } catch (error) {
      connectionSource += `; getBusinessConnection failed: ${explain(error)}`
    }
  }

  const checks: Check[] = []
  const record = (label: string, status: Status, evidence: string) => {
    checks.push({ label, status, evidence })
    console.log(`  ${status} ${label}: ${evidence}`)
  }
  const connected = Boolean(connection?.isEnabled && connection.rights.canReply)
  record(
    '(a) business_connection enabled with can_reply',
    connected ? 'PASS' : 'FAIL',
    connection
      ? `${connectionSource}; is_enabled=${connection.isEnabled}; can_reply=${connection.rights.canReply}; rights sent by Telegram: ${rightNames}`
      : `no connection seen (${connectionSource})`,
  )
  record(
    '(b) customer DM arrives as business_message',
    incoming ? 'PASS' : 'FAIL',
    incoming
      ? `update ${incoming.event.updateId}, message ${incoming.event.messageId}, sent ${incoming.event.dateIso}, received ${incoming.at}`
      : 'no incoming business_message during the run',
  )

  const ready =
    connected && incoming !== undefined && connectionId !== undefined
  const chatId = incoming?.event.chatId ?? 0
  const notRun = 'not attempted: needs (a) and (b)'

  // (c) reply in the customer's thread through the connection.
  let replyId: number | undefined
  if (ready) {
    console.log(`3. Sending "${REPLY_TEXT}" through the connection...`)
    try {
      replyId = (await adapter.sendText(chatId, REPLY_TEXT, { connectionId }))
        .messageId
      record(
        '(c) reply in the customer thread via the connection',
        'PASS',
        `message ${replyId} sent ${iso()}`,
      )
      console.log(
        "   Check the customer's chat: the reply should show as sent by the owner account.",
      )
    } catch (error) {
      record(
        '(c) reply in the customer thread via the connection',
        'FAIL',
        explain(error),
      )
    }
  } else {
    record(
      '(c) reply in the customer thread via the connection',
      'FAIL',
      notRun,
    )
  }

  // (d) inline callback_data button on a business message -> callback_query.
  let buttonId: number | undefined
  const dLabel = '(d) inline callback_data button -> callback_query'
  if (ready) {
    try {
      buttonId = (
        await adapter.sendWithButton(
          chatId,
          BUTTON_TEXT,
          { text: 'Test', callbackData },
          { connectionId },
        )
      ).messageId
      console.log(
        `4. As the customer, tap "Test" under message ${buttonId} (waiting up to 2 minutes).`,
      )
      const callback = await waitFor(
        () => seen.callback,
        Math.min(deadline, Date.now() + CALLBACK_WAIT_MS),
        run.signal,
      )
      if (!callback) {
        record(dLabel, 'FAIL', `button message ${buttonId}; no callback_query`)
      } else {
        const { event } = callback
        const from =
          event.fromId === chatId
            ? 'the customer'
            : event.fromId === ownerUserId
              ? 'the owner'
              : 'another user'
        let answered = 'answered'
        try {
          await adapter.answerCallback(event.callbackQueryId, 'Received')
        } catch (error) {
          answered = `answer failed: ${explain(error)}`
        }
        record(
          dLabel,
          event.fromId === chatId &&
            event.messageId === buttonId &&
            answered === 'answered'
            ? 'PASS'
            : 'FAIL',
          `button message ${buttonId}; callback at ${callback.at} from ${from} on message ${event.messageId}; connection id on callback: ${event.connectionId ? 'yes' : 'no'}; ${answered}`,
        )
      }
    } catch (error) {
      record(dLabel, 'FAIL', `button send failed: ${explain(error)}`)
    }
  } else {
    record(dLabel, 'FAIL', notRun)
  }

  // (e) readBusinessMessage, only with can_read_messages.
  const eLabel = "(e) readBusinessMessage on the customer's message"
  if (!ready || !incoming) {
    record(eLabel, 'FAIL', notRun)
  } else if (!connection?.rights.canReadMessages) {
    record(eLabel, 'SKIP', 'the connection lacks can_read_messages')
  } else {
    try {
      await adapter.markRead(chatId, incoming.event.messageId, connectionId)
      record(eLabel, 'PASS', `message ${incoming.event.messageId} at ${iso()}`)
    } catch (error) {
      record(eLabel, 'FAIL', explain(error))
    }
  }

  // (f) deleteBusinessMessages on the spike's own button message, only with a delete right.
  const fLabel = "(f) deleteBusinessMessages on the spike's own message"
  if (buttonId === undefined || !connectionId) {
    record(fLabel, 'FAIL', 'not attempted: no button message from (d)')
  } else if (
    !connection?.rights.canDeleteSentMessages &&
    !connection?.rights.canDeleteAllMessages
  ) {
    record(fLabel, 'SKIP', 'the connection lacks a delete right')
  } else {
    try {
      await adapter.deleteMessages(chatId, [buttonId], connectionId)
      record(fLabel, 'PASS', `message ${buttonId} at ${iso()}`)
    } catch (error) {
      record(fLabel, 'FAIL', explain(error))
    }
  }

  clearTimeout(runTimer)
  process.off('SIGINT', interrupt)
  const grace = (ms: number) => sleep(ms, undefined, { ref: false })
  await Promise.race([adapter.stop(), grace(10_000)])
  await Promise.race([polling, grace(1_000)])

  const [a, b, c, d] = checks
  const proven = [a, b, c].every((check) => check?.status === 'PASS')
  const username = adapter.bot.isInited()
    ? `@${adapter.bot.botInfo.username}`
    : 'an unverified bot'
  const echo =
    replyId === undefined
      ? []
      : [
          `- Telegram echoed the reply ${replyId} as a business_message with sender_business_bot: ${seen.botEchoes.has(replyId) ? 'yes' : 'no'}.`,
        ]
  const block = [
    `### S1 Telegram (live run) ${startedAt}`,
    '',
    `\`npx tsx scripts/spike-telegram.ts\` as ${username}, ${startedAt} to ${iso()}. Ids, rights and ISO times only; no message text, no token.`,
    '',
    '| Check | Result | Evidence |',
    '| --- | --- | --- |',
    ...checks.map(
      ({ label, status, evidence }) => `| ${label} | ${status} | ${evidence} |`,
    ),
    '',
    ...echo,
    ...(pollingError ? [`- Polling stopped with: ${pollingError}`] : []),
    `- Suggested \`CALLBACKS_SUPPORTED=${d?.status === 'PASS'}\` (true only when (d) passed).`,
    proven
      ? '- Recommended `TELEGRAM_MODE=business`: (a)-(c) passed.'
      : '- Recommended `TELEGRAM_MODE`: undecided. (a)-(c) did not all pass, so stop and ask the user before any switch to `bot` (plan rule 12).',
  ].join('\n')
  const doc = existsSync(SPIKES_PATH)
    ? readFileSync(SPIKES_PATH, 'utf8')
    : '# Spikes\n'
  writeFileSync(SPIKES_PATH, insertUnderS1(doc, block))
  console.log(
    `Results appended to docs/SPIKES.md under "S1 Telegram". (a)-(c): ${proven ? 'PASS' : 'NOT ALL PASSED'}.`,
  )
  return proven ? 0 : 1
}

if (import.meta.main) process.exitCode = await main()
