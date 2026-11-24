import { DateTime } from 'luxon'
import type { ShopConfig } from '../shop/config.js'
import { parseSchedule } from './schedule.js'
import { matchService } from './service.js'

export type ParseResult = {
  intent: 'book' | 'cancel' | 'unknown'
  serviceId?: string
  startUtc?: string
  confidence: number
  needs: Array<'date' | 'time' | 'service'>
}

export function parseRequest(
  text: string,
  now: Date,
  shop: ShopConfig,
): ParseResult {
  const service = matchService(text, shop.services)
  const booking = /\b(?:book me|can i book|appointment)\b|^\s*book\b/i.test(
    text,
  )
  const localNow = DateTime.fromJSDate(now, { zone: shop.timezone })
  const schedule = parseSchedule(text, localNow, shop, !!service || booking)
  const cancel = /\b(?:cancel|(?:can['’]?t|won['’]?t)\s+make\s+it)\b/i.test(
    text,
  )
  let intent: ParseResult['intent'] = 'unknown'
  if (cancel) intent = 'cancel'
  else if (booking || service || schedule.hasTime || schedule.hasDate)
    intent = 'book'

  const needs: ParseResult['needs'] = []
  if (!schedule.hasDate) needs.push('date')
  if (!schedule.hasTime) needs.push('time')
  if (!service) needs.push('service')

  let confidence = 1
  if (schedule.inferred || service?.inferred) confidence = 0.85
  if (needs.length) confidence = 0.8 - needs.length * 0.1
  if (schedule.closedDay) confidence = Math.min(confidence, 0.5)
  if (intent === 'unknown') confidence = 0
  return {
    intent,
    serviceId: service?.id ?? shop.defaultServiceId,
    ...(schedule.startUtc && { startUtc: schedule.startUtc }),
    confidence,
    needs,
  }
}
