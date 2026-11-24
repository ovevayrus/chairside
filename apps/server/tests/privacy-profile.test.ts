import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { applyBotProfile } from '../src/privacy/profile.js'
import { BusinessTelegramAdapter } from '../src/telegram/business.js'
import { ShopBotTelegramAdapter } from '../src/telegram/shopbot.js'

const api = setupServer()
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }))
afterEach(() => api.resetHandlers())
afterAll(() => api.close())

it.each([
  {
    mode: 'Business',
    Adapter: BusinessTelegramAdapter,
    scope: 'Chairside reads booking messages only in chats the owner connects.',
    shortScope: 'Bookings in owner-linked chats only.',
  },
  {
    mode: 'shop-bot',
    Adapter: ShopBotTelegramAdapter,
    scope:
      'Chairside reads booking messages sent directly to this bot in a private chat.',
    shortScope: 'Booking DMs to this bot only.',
  },
])(
  'publishes the $mode booking scope to both Bot API profile fields',
  async ({ Adapter, scope, shortScope }) => {
    const token = `${'4'.repeat(10)}:${'T'.repeat(35)}`
    const adapter = new Adapter({ token, ownerUserId: 123 })
    const calls: { method: string; body: unknown }[] = []
    api.use(
      http.post(
        'https://api.telegram.org/:bot/:method',
        async ({ request, params }) => {
          calls.push({
            method: String(params.method),
            body: await request.json(),
          })
          return HttpResponse.json({ ok: true, result: true })
        },
      ),
    )

    await applyBotProfile(adapter)

    const description = `${scope} It checks the owner's calendar and sends booking replies only after the owner approves the action on their glasses. If you accept an offer the owner approved, Chairside confirms the booking. Chairside does not store message text.`
    const shortDescription = `${shortScope} Checks owner's calendar. Owner approves replies on glasses. No message text stored.`
    expect(calls).toEqual([
      { method: 'setMyDescription', body: { description } },
      {
        method: 'setMyShortDescription',
        body: { short_description: shortDescription },
      },
    ])
    expect(description.length).toBeLessThanOrEqual(512)
    expect(shortDescription.length).toBeLessThanOrEqual(120)
  },
)
