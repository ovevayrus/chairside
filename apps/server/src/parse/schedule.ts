import { en, type ParsedResult } from 'chrono-node'
import { DateTime } from 'luxon'
import type { ShopConfig } from '../shop/config.js'

function calendarDay(result: ParsedResult, now: DateTime): DateTime {
  const { start } = result
  const weekday = start.get('weekday')
  // Resolve unqualified weekdays on the shop calendar. Chrono can advance
  // even a same-day weekday before it has merged in the requested time.
  if (
    weekday !== null &&
    !start.isCertain('day') &&
    !/\b(next|last|past)\b/i.test(result.text)
  ) {
    return now.startOf('day').plus({ days: (weekday - now.weekday + 7) % 7 })
  }
  const month = start.get('month') ?? now.month
  const day = start.get('day') ?? now.day
  const sameDay = month === now.month && day === now.day
  const year =
    sameDay && !start.isCertain('year')
      ? now.year
      : (start.get('year') ?? now.year)
  return DateTime.fromObject({ year, month, day }, { zone: now.zone })
}

function readLooseHour(
  text: string,
  results: ParsedResult[],
  bookingContext: boolean,
): number | undefined {
  // Exclude every span already parsed, so the 5 in "Sat 5 Dec" cannot
  // become a time. Colons, slashes and hyphens also protect numeric dates.
  let remainder = text
  for (const result of results.toReversed()) {
    remainder =
      remainder.slice(0, result.index) +
      ' ' +
      remainder.slice(result.index + result.text.length)
  }
  const match = /(?<![\w/:.+-])(\d{1,2})(-?ish)?(?![\w/:+-]|\.\d)/i.exec(
    remainder,
  )
  if (!match || Number(match[1]) > 23) return undefined
  const surrounding =
    remainder.slice(0, match.index) +
    remainder.slice(match.index + match[0].length)
  if (
    !bookingContext &&
    !match[2] &&
    /\w/.test(surrounding) &&
    !/\b(?:at|around|about|after)\s*$/i.test(remainder.slice(0, match.index))
  )
    return undefined
  return Number(match[1])
}

export function parseSchedule(
  text: string,
  now: DateTime,
  shop: ShopConfig,
  bookingContext: boolean,
) {
  // The GB grammar reads numeric dates as day/month. The reference offset
  // is for now; Luxon applies the shop's offset on the actual requested day.
  const results = en.GB.parse(
    text,
    { instant: now.toJSDate(), timezone: now.offset },
    { forwardDate: true },
  )
  const dateResult = results.find(
    ({ start }) => start.isCertain('day') || start.isCertain('weekday'),
  )
  const day = dateResult && calendarDay(dateResult, now)
  const hours = shop.hours[(day ?? now).weekday]
  const timeResult = results.find(({ start }) => start.isCertain('hour'))
  let hour =
    timeResult?.start.get('hour') ??
    readLooseHour(text, results, !!day || bookingContext)
  const minute = timeResult?.start.get('minute') ?? 0
  const explicitClock =
    timeResult &&
    (timeResult.start.isCertain('meridiem') ||
      /\b(?:noon|midday|midnight|(?:[01]\d|2[0-3]):[0-5]\d)\b/i.test(
        timeResult.text,
      ))
  if (hour !== undefined && hour >= 1 && hour <= 8 && !explicitClock) {
    const opensLate = hours
      ? hours.open >= '09:00'
      : Object.values(shop.hours).every(({ open }) => open >= '09:00')
    if (opensLate) hour += 12
  }
  let start =
    hour === undefined
      ? undefined
      : (day ?? now).set({ hour, minute, second: 0, millisecond: 0 })
  if (start && !day) {
    const clock = start.toFormat('HH:mm')
    if (!hours || start <= now || clock < hours.open || clock >= hours.close)
      start = undefined
  }
  if (
    start &&
    dateResult?.start.isCertain('weekday') &&
    !dateResult.start.isCertain('day') &&
    !/\b(this|next|last|past)\b/i.test(dateResult.text) &&
    start < now
  ) {
    start = start.plus({ days: 7 })
  }
  return {
    hasDate: !!day || !!start,
    hasTime: hour !== undefined,
    startUtc: start?.toUTC().toISO() ?? undefined,
    inferred:
      !day ||
      !explicitClock ||
      /\b(?:around|about|after)\s+\d|\d-?ish\b/i.test(text),
    closedDay: !!day && !hours,
  }
}
