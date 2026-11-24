import { BusinessTelegramAdapter } from '../telegram/business.js'
import type { ShopBotTelegramAdapter } from '../telegram/shopbot.js'

/** Publish the active mode's default-language profile before starting live polling. */
export function applyBotProfile(
  adapter: BusinessTelegramAdapter | ShopBotTelegramAdapter,
): Promise<void> {
  const business = adapter instanceof BusinessTelegramAdapter
  const scope = business
    ? 'Chairside reads booking messages only in chats the owner connects.'
    : 'Chairside reads booking messages sent directly to this bot in a private chat.'
  const shortScope = business
    ? 'Bookings in owner-linked chats only.'
    : 'Booking DMs to this bot only.'
  return adapter.setProfileDescriptions(
    [
      scope,
      "It checks the owner's calendar and sends booking replies only after the owner approves the action on their glasses.",
      'If you accept an offer the owner approved, Chairside confirms the booking.',
      'Chairside does not store message text.',
    ].join(' '),
    `${shortScope} Checks owner's calendar. Owner approves replies on glasses. No message text stored.`,
  )
}
