import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { BotFullInfo, Update } from 'grammy/types'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  TelegramApiError,
  TelegramNetworkError,
  TelegramTimeoutError,
} from '../src/telegram/adapter.js'
import {
  ALLOWED_UPDATES,
  BusinessTelegramAdapter,
} from '../src/telegram/business.js'
import {
  normalizeConnection,
  type TelegramEvent,
} from '../src/telegram/events.js'
import type { GrammyAdapter } from '../src/telegram/grammy.js'
import { ShopBotTelegramAdapter } from '../src/telegram/shopbot.js'

// Assembled at runtime so the repository never holds a token-shaped string.
const token = `${'4'.repeat(10)}:${'T'.repeat(35)}`
const OWNER = 801234567
const ANNA = 612345678
const CONNECTION = 'Kx3mQ7vRzEwSAAAAqP9dLb2YtNc'
const BUTTON = { text: 'Book 16:00', callbackData: 'offer:o-1' }

const botInfo: BotFullInfo = {
  id: 7712345678,
  is_bot: true,
  first_name: 'Chairside',
  username: 'chairside_demo_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_guest_queries: false,
  supports_inline_queries: false,
  needs_inline_query_location: false,
  can_connect_to_business: true,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  has_topic_sidebar: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

/** Loads a recorded update, optionally editing its JSON text first. */
function fixture(name: string, edit = (json: string) => json): Update {
  const json = readFileSync(
    new URL(`./fixtures/telegram/${name}.json`, import.meta.url),
    'utf8',
  )
  return JSON.parse(edit(json))
}

interface ApiCall {
  method: string
  body: Record<string, unknown>
}
let calls: ApiCall[] = []

// Answers like the Bot API: the sent message for sendMessage, `true` for the rest.
function succeed({ method, body }: ApiCall): Response {
  if (method !== 'sendMessage') {
    return HttpResponse.json({ ok: true, result: true })
  }
  const sender = body.business_connection_id
    ? {
        from: { id: OWNER, is_bot: false, first_name: 'Karim' },
        business_connection_id: body.business_connection_id,
        sender_business_bot: botInfo,
      }
    : { from: botInfo }
  return HttpResponse.json({
    ok: true,
    result: {
      message_id: 9001,
      ...sender,
      chat: { id: body.chat_id, first_name: 'Anna', type: 'private' },
      date: 1795856700,
      text: body.text,
    },
  })
}

/** Stands in for api.telegram.org: records every call, then answers it. */
function botApi(
  respond: (call: ApiCall) => Response | Promise<Response> = succeed,
) {
  return http.post(
    'https://api.telegram.org/:bot/:method',
    async ({ request, params }) => {
      if (params.bot !== `bot${token}`) {
        return HttpResponse.json(
          { ok: false, error_code: 401, description: 'Unauthorized' },
          { status: 401 },
        )
      }
      const call: ApiCall = {
        method: String(params.method),
        body: (await request.json()) as Record<string, unknown>,
      }
      calls.push(call)
      return respond(call)
    },
  )
}

const server = setupServer(botApi())
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => {
  calls = []
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const business = () =>
  new BusinessTelegramAdapter({ token, ownerUserId: OWNER, botInfo })
const shopbot = () =>
  new ShopBotTelegramAdapter({ token, ownerUserId: OWNER, botInfo })

/** Feeds updates through grammY's own update handling; returns the emitted events. */
async function receive(
  adapter: GrammyAdapter,
  ...updates: Update[]
): Promise<TelegramEvent[]> {
  const events: TelegramEvent[] = []
  adapter.onEvent((event) => {
    events.push(event)
  })
  for (const update of updates) await adapter.bot.handleUpdate(update)
  return events
}

describe('business adapter: recorded inbound updates', () => {
  it('maps business_connection to the owner, the enabled flag and the bot rights', async () => {
    expect(await receive(business(), fixture('business_connection'))).toEqual([
      {
        type: 'connection',
        updateId: 731400001,
        connectionId: CONNECTION,
        ownerUserId: OWNER,
        ownerChatId: OWNER,
        isEnabled: true,
        rights: {
          canReply: true,
          canReadMessages: true,
          canDeleteSentMessages: true,
          canDeleteAllMessages: false,
        },
      },
    ])
  })

  it('accepts can_delete_sent_messages as the delete right and treats missing rights as none', async () => {
    const renamed = fixture('business_connection', (json) =>
      json.replace('can_delete_outgoing_messages', 'can_delete_sent_messages'),
    )
    const disabled = fixture('business_connection', (json) =>
      json
        .replace(/"rights": \{[^}]*\},/, '')
        .replace('"is_enabled": true', '"is_enabled": false'),
    )
    const [first, second] = await receive(business(), renamed, disabled)
    expect(first).toMatchObject({
      rights: { canReply: true, canDeleteSentMessages: true },
    })
    expect(second).toMatchObject({
      isEnabled: false,
      rights: {
        canReply: false,
        canReadMessages: false,
        canDeleteSentMessages: false,
        canDeleteAllMessages: false,
      },
    })
  })

  it('maps a customer business_message to an incoming message', async () => {
    expect(await receive(business(), fixture('business_message'))).toEqual([
      {
        type: 'message',
        updateId: 731400003,
        connectionId: CONNECTION,
        chatId: ANNA,
        messageId: 5101,
        fromId: ANNA,
        firstName: 'Anna',
        text: 'Can I get a skin fade Saturday 5 Dec at 3pm?',
        dateIso: '2026-11-28T09:00:00.000Z',
        direction: 'incoming',
      },
    ])
  })

  it("marks the owner's manual reply outgoing_owner and the bot's own message outgoing_bot", async () => {
    const [manual, ours] = await receive(
      business(),
      fixture('business_message_owner_reply'),
      fixture('business_message_from_bot'),
    )
    expect(manual).toMatchObject({
      type: 'message',
      updateId: 731400005,
      connectionId: CONNECTION,
      chatId: ANNA,
      messageId: 5102,
      fromId: OWNER,
      direction: 'outgoing_owner',
    })
    expect(ours).toMatchObject({
      type: 'message',
      chatId: ANNA,
      messageId: 5103,
      direction: 'outgoing_bot',
    })
  })

  it('maps edited_business_message to an edited event', async () => {
    expect(
      await receive(business(), fixture('edited_business_message')),
    ).toEqual([
      {
        type: 'edited',
        updateId: 731400004,
        connectionId: CONNECTION,
        chatId: ANNA,
        messageId: 5101,
        fromId: ANNA,
        firstName: 'Anna',
        text: 'Can I get a skin fade Saturday 5 Dec at 4pm?',
        dateIso: '2026-11-28T09:00:00.000Z',
        direction: 'incoming',
      },
    ])
  })

  it('maps deleted_business_messages to a deleted event', async () => {
    expect(
      await receive(business(), fixture('deleted_business_messages')),
    ).toEqual([
      {
        type: 'deleted',
        updateId: 731400008,
        connectionId: CONNECTION,
        chatId: ANNA,
        messageIds: [5101],
      },
    ])
  })

  it("maps a callback_query on the bot's business message, keeping the connection id", async () => {
    expect(await receive(business(), fixture('callback_query'))).toEqual([
      {
        type: 'callback',
        updateId: 731400007,
        callbackQueryId: '3480012345678901234',
        fromId: ANNA,
        chatId: ANNA,
        messageId: 5103,
        data: 'offer:o-1',
        connectionId: CONNECTION,
      },
    ])
  })

  it("delivers the owner's /pair in the bot chat as an incoming message without a connection", async () => {
    expect(await receive(business(), fixture('message_owner_command'))).toEqual(
      [
        {
          type: 'message',
          updateId: 731400002,
          connectionId: undefined,
          chatId: OWNER,
          messageId: 37,
          fromId: OWNER,
          firstName: 'Karim',
          text: '/pair K7P2QX',
          dateIso: '2026-11-28T08:55:00.000Z',
          direction: 'incoming',
        },
      ],
    )
  })

  it('ignores group chats', async () => {
    const group = fixture('message_owner_command', (json) =>
      json.replace('"type": "private"', '"type": "group"'),
    )
    expect(await receive(business(), group)).toEqual([])
  })

  it('makes no Bot API call while receiving (no getMe, no automatic reply or read)', async () => {
    const names = [
      'business_connection',
      'message_owner_command',
      'business_message',
      'edited_business_message',
      'business_message_owner_reply',
      'business_message_from_bot',
      'callback_query',
      'deleted_business_messages',
    ]
    const events = await receive(business(), ...names.map((n) => fixture(n)))
    expect(events).toHaveLength(names.length)
    expect(calls).toEqual([])
  })
})

describe('business adapter: outbound calls', () => {
  it('sendText posts sendMessage through the connection and returns the message id', async () => {
    const text = 'Booked: Saturday 5 Dec, 15:00 skin fade. See you then!'
    await expect(
      business().sendText(ANNA, text, { connectionId: CONNECTION }),
    ).resolves.toEqual({ messageId: 9001 })
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        body: { chat_id: ANNA, text, business_connection_id: CONNECTION },
      },
    ])
  })

  it('sendWithButton attaches one inline callback_data button', async () => {
    await expect(
      business().sendWithButton(
        ANNA,
        'Saturday 5 Dec, 16:00 is free. Shall I book it?',
        BUTTON,
        { connectionId: CONNECTION },
      ),
    ).resolves.toEqual({ messageId: 9001 })
    expect(calls).toHaveLength(1)
    const [{ method, body }] = calls as [ApiCall]
    expect(method).toBe('sendMessage')
    expect(body).toHaveProperty('business_connection_id', CONNECTION)
    expect(body).toHaveProperty(
      ['reply_markup', 'inline_keyboard', 0, 0, 'callback_data'],
      'offer:o-1',
    )
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Book 16:00', callback_data: 'offer:o-1' }]],
    })
  })

  it('markRead and deleteMessages call readBusinessMessage and deleteBusinessMessages', async () => {
    const adapter = business()
    await adapter.markRead(ANNA, 5101, CONNECTION)
    await adapter.deleteMessages(ANNA, [5103], CONNECTION)
    expect(calls).toEqual([
      {
        method: 'readBusinessMessage',
        body: {
          business_connection_id: CONNECTION,
          chat_id: ANNA,
          message_id: 5101,
        },
      },
      {
        method: 'deleteBusinessMessages',
        body: { business_connection_id: CONNECTION, message_ids: [5103] },
      },
    ])
  })

  it('getConnection fetches the current connection for normalizeConnection', async () => {
    const { business_connection: recorded } = fixture('business_connection')
    server.use(
      botApi((call) =>
        call.method === 'getBusinessConnection'
          ? HttpResponse.json({ ok: true, result: recorded })
          : succeed(call),
      ),
    )
    const connection = await business().getConnection(CONNECTION)
    expect(calls).toEqual([
      {
        method: 'getBusinessConnection',
        body: { business_connection_id: CONNECTION },
      },
    ])
    expect(normalizeConnection(connection)).toEqual({
      connectionId: CONNECTION,
      ownerUserId: OWNER,
      ownerChatId: OWNER,
      isEnabled: true,
      rights: {
        canReply: true,
        canReadMessages: true,
        canDeleteSentMessages: true,
        canDeleteAllMessages: false,
      },
    })
  })

  it('answerCallback answers the callback query, with or without a notice', async () => {
    const adapter = business()
    await adapter.answerCallback('3480012345678901234', 'Booked')
    await adapter.answerCallback('3480012345678901235')
    expect(calls).toEqual([
      {
        method: 'answerCallbackQuery',
        body: { callback_query_id: '3480012345678901234', text: 'Booked' },
      },
      {
        method: 'answerCallbackQuery',
        body: { callback_query_id: '3480012345678901235' },
      },
    ])
  })

  it('aborts a send slower than timeoutMs with TelegramTimeoutError and never retries', async () => {
    server.use(
      botApi(async (call) => {
        await delay(1_000)
        return succeed(call)
      }),
    )
    const started = performance.now()
    const error = await business()
      .sendText(ANNA, 'Booked', { connectionId: CONNECTION, timeoutMs: 50 })
      .catch((caught: unknown) => caught)
    expect(performance.now() - started).toBeLessThan(900)
    expect(error).toBeInstanceOf(TelegramTimeoutError)
    expect(error).toMatchObject({ method: 'sendMessage', timeoutMs: 50 })
    await sleep(100)
    expect(calls.map(({ method }) => method)).toEqual(['sendMessage'])
  })

  it('turns a 400 into TelegramApiError with the code, keeps no message text and never retries', async () => {
    server.use(
      botApi(() =>
        HttpResponse.json(
          {
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat not found',
          },
          { status: 400 },
        ),
      ),
    )
    const text = 'Saturday 5 Dec, 16:00 is free. Shall I book it?'
    const error = await business()
      .sendWithButton(ANNA, text, BUTTON, { connectionId: CONNECTION })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TelegramApiError)
    expect(error).toMatchObject({
      method: 'sendMessage',
      code: 400,
      description: 'Bad Request: chat not found',
    })
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(text)
    expect(calls).toHaveLength(1)
  })

  it('turns a network failure into TelegramNetworkError without the token-bearing URL', async () => {
    server.use(botApi(() => HttpResponse.error()))
    const error = await business()
      .sendText(ANNA, 'Booked', { connectionId: CONNECTION })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TelegramNetworkError)
    expect(error).toMatchObject({ method: 'sendMessage' })
    expect(error).not.toHaveProperty('cause')
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(token)
    expect(calls).toHaveLength(1)
  })

  it('gives every call an 8 s timeout by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const adapter = business()
      await adapter.sendText(ANNA, 'Booked', { connectionId: CONNECTION })
      await adapter.markRead(ANNA, 5101, CONNECTION)
      expect(timeout.mock.calls).toEqual([[8_000], [8_000]])
    } finally {
      timeout.mockRestore()
    }
  })

  it('long-polls with ALLOWED_UPDATES without calling getMe, and stops cleanly', async () => {
    expect(ALLOWED_UPDATES).toEqual([
      'message',
      'callback_query',
      'business_connection',
      'business_message',
      'edited_business_message',
      'deleted_business_messages',
    ])
    let delivered = false
    server.use(
      botApi(async (call) => {
        if (call.method !== 'getUpdates') return succeed(call)
        if (delivered) {
          await sleep(20)
          return HttpResponse.json({ ok: true, result: [] })
        }
        delivered = true
        return HttpResponse.json({
          ok: true,
          result: [fixture('business_message')],
        })
      }),
    )
    const adapter = business()
    const received = new Promise<TelegramEvent>((resolve) => {
      adapter.onEvent(resolve)
    })
    let started = false
    const polling = adapter.start(() => {
      started = true
    })
    await expect(received).resolves.toMatchObject({
      type: 'message',
      updateId: 731400003,
      direction: 'incoming',
    })
    await adapter.stop()
    await polling
    expect(started).toBe(true)
    expect(calls.map(({ method }) => method)).not.toContain('getMe')
    expect(
      calls.find(({ method }) => method === 'getUpdates')?.body,
    ).toHaveProperty('allowed_updates', [...ALLOWED_UPDATES])
  })
})

describe('event stream', () => {
  it('stops delivering to a handler once it unsubscribes', async () => {
    const adapter = business()
    const seen: string[] = []
    const unsubscribe = adapter.onEvent((event) => {
      seen.push(event.type)
    })
    await adapter.bot.handleUpdate(fixture('business_connection'))
    unsubscribe()
    await adapter.bot.handleUpdate(fixture('business_message'))
    expect(seen).toEqual(['connection'])
  })

  it('keeps delivering when a handler throws, and logs ids only, never message text', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const adapter = business()
      const delivered: number[] = []
      adapter.onEvent((event) => {
        if (event.type === 'message') throw new Error(`Bad input ${event.text}`)
      })
      adapter.onEvent((event) => {
        delivered.push(event.updateId)
      })
      await adapter.bot.handleUpdate(fixture('business_message'))
      expect(delivered).toEqual([731400003])
      expect(logged).toHaveBeenCalledOnce()
      const output = logged.mock.calls.flat().map(String).join(' ')
      expect(output).toContain('731400003')
      expect(output).not.toContain('skin fade')
    } finally {
      logged.mockRestore()
    }
  })
})

describe('shop-bot adapter', () => {
  it('sends in the plain bot chat, never with business_connection_id', async () => {
    const adapter = shopbot()
    await adapter.sendText(ANNA, 'Hi Anna', { connectionId: CONNECTION })
    await adapter.sendWithButton(ANNA, 'Shall I book it?', BUTTON, {
      connectionId: CONNECTION,
    })
    expect(calls.map(({ method }) => method)).toEqual([
      'sendMessage',
      'sendMessage',
    ])
    for (const { body } of calls) {
      expect(body).not.toHaveProperty('business_connection_id')
    }
    expect(calls[1]?.body).toHaveProperty(
      ['reply_markup', 'inline_keyboard', 0, 0, 'callback_data'],
      'offer:o-1',
    )
  })

  it('treats markRead as a no-op and deletes through deleteMessages', async () => {
    const adapter = shopbot()
    await adapter.markRead()
    await adapter.deleteMessages(ANNA, [9001, 9002])
    expect(calls).toEqual([
      {
        method: 'deleteMessages',
        body: { chat_id: ANNA, message_ids: [9001, 9002] },
      },
    ])
  })

  it('receives customer DMs and their edits as incoming events without a connection', async () => {
    const plain = (name: string, from: string, to: string) =>
      fixture(name, (json) =>
        json
          .replace(`"${from}"`, `"${to}"`)
          .replace(/"business_connection_id": "[^"]+",\s*/, ''),
      )
    const adapter = shopbot()
    expect(adapter.allowedUpdates).toEqual([
      'message',
      'edited_message',
      'callback_query',
    ])
    const events = await receive(
      adapter,
      plain('business_message', 'business_message', 'message'),
      plain(
        'edited_business_message',
        'edited_business_message',
        'edited_message',
      ),
    )
    const dm = {
      connectionId: undefined,
      chatId: ANNA,
      messageId: 5101,
      fromId: ANNA,
      firstName: 'Anna',
      dateIso: '2026-11-28T09:00:00.000Z',
      direction: 'incoming',
    }
    expect(events).toEqual([
      {
        ...dm,
        type: 'message',
        updateId: 731400003,
        text: 'Can I get a skin fade Saturday 5 Dec at 3pm?',
      },
      {
        ...dm,
        type: 'edited',
        updateId: 731400004,
        text: 'Can I get a skin fade Saturday 5 Dec at 4pm?',
      },
    ])
  })
})
