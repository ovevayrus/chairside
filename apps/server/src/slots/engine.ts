import { DateTime } from 'luxon'

export type WeeklyHours = Partial<
  Record<1 | 2 | 3 | 4 | 5 | 6 | 7, { open: string; close: string }>
>

export interface Interval {
  startUtc: string
  endUtc: string
}

export interface FindOpeningsInput {
  hours: WeeklyHours
  closedDates?: string[]
  tz: string
  durationMin: number
  bufferMin: number
  gridMin: number
  busy: Interval[]
  from: string
  requested?: string
  /** Let the single requested start use any minute. Alternatives stay on the grid. */
  allowOffGridRequest?: boolean
  count?: number
  horizonDays?: number
}

export interface FindOpeningsResult {
  requestedFits: boolean
  openings: Interval[]
}

const minuteMs = 60_000

function firstOccurrence(time: DateTime<true>) {
  return time.getPossibleOffsets().reduce((a, b) => (a < b ? a : b))
}

function resolveTime(iso: string, tz: string) {
  // Preserve explicit offsets, including the second occurrence of a repeated hour.
  const parsed = DateTime.fromISO(iso, { zone: tz, setZone: true })
  if (!parsed.isValid) throw new RangeError('Invalid ISO date/time')
  let time = firstOccurrence(parsed)
  const exact = parsed.isOffsetFixed || parsed.hasSame(
    DateTime.fromISO(iso, { zone: 'utc', setZone: true }), 'millisecond',
  )
  if (!exact) {
    // Luxon shifts an offsetless time in a spring gap forward by the gap's
    // length. The first real minute following the gap is the search boundary.
    time = time.startOf('minute')
    while (time.minus({ minutes: 1 }).offset === parsed.offset) {
      time = time.minus({ minutes: 1 })
    }
  }
  const local = time.setZone(tz)
  if (!local.isValid) throw new RangeError('Invalid shop time zone')
  return { local, exact }
}

function startOfDay(time: DateTime<true>) {
  return firstOccurrence(time.startOf('day'))
}

function clockMinutes(hhmm: string) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
}

function wallMinute(time: DateTime) {
  return time.hour * 60 + time.minute
}

function startsWithinHours(
  day: DateTime<true>,
  nextDay: DateTime<true>,
  hours: { open: string; close: string },
  durationMs: number,
  gridMin: number,
  offGridRequest: number,
): number[] {
  const open = clockMinutes(hours.open)
  const close = clockMinutes(hours.close)
  const midnight = day.toMillis()
  const end = nextDay.toMillis()
  const changesOffset = day.offset !== nextDay.minus(1).offset
  const firstMinute = wallMinute(day)
  const starts: number[] = []

  // Walk real minutes backwards so openUntil always marks the end of the
  // contiguous open period, even if the clock falls back into closed hours.
  let openUntil = end
  for (let time = end - minuteMs; time >= midnight; time -= minuteMs) {
    const minute = changesOffset
      ? wallMinute(DateTime.fromMillis(time, { zone: day.zone }))
      : firstMinute + (time - midnight) / minuteMs
    if (minute < open || minute >= close) {
      openUntil = time
    } else if (
      (minute % gridMin === 0 || time === offGridRequest) &&
      time + durationMs <= openUntil
    ) {
      starts.push(time)
    }
  }
  return starts.reverse()
}

export function findOpenings({
  hours,
  closedDates = [],
  tz,
  durationMin,
  bufferMin,
  gridMin,
  busy,
  from,
  requested,
  allowOffGridRequest = false,
  count = 3,
  horizonDays = 7,
}: FindOpeningsInput): FindOpeningsResult {
  if (
    !Number.isFinite(durationMin) ||
    durationMin <= 0 ||
    !Number.isFinite(bufferMin) ||
    bufferMin < 0 ||
    !Number.isSafeInteger(gridMin) ||
    gridMin <= 0 ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(horizonDays) ||
    horizonDays < 0
  ) {
    throw new RangeError(
      'Invalid slot duration, buffer, grid, count, or horizon',
    )
  }

  const earliest = resolveTime(from, tz).local
  const request =
    requested === undefined ? undefined : resolveTime(requested, tz)
  const requestedMs = request?.local.toMillis() ?? -Infinity
  const durationMs = durationMin * minuteMs
  const bufferMs = bufferMin * minuteMs
  const blocked = busy.map(({ startUtc, endUtc }) => ({
    start: resolveTime(startUtc, tz).local.toMillis() - bufferMs,
    end: resolveTime(endUtc, tz).local.toMillis() + bufferMs,
  }))
  const closed = new Set(closedDates)
  const preferred: number[] = []
  const earlier: number[] = []
  let requestedFits = false
  let day = startOfDay(request && request.local > earliest ? request.local : earliest)

  // The horizon counts local dates starting with the first searchable day.
  // Even with no alternatives requested, the requested instant gets checked.
  const daysToCheck = Math.max(horizonDays, request ? 1 : 0)
  for (let index = 0; index < daysToCheck; index++) {
    const nextDay = startOfDay(day.plus({ days: 1 }))
    const hoursToday = hours[day.weekday]
    if (hoursToday && !closed.has(day.toISODate())) {
      for (const start of startsWithinHours(
        day,
        nextDay,
        hoursToday,
        durationMs,
        gridMin,
        allowOffGridRequest && request?.exact ? requestedMs : -Infinity,
      )) {
        if (
          start < earliest.toMillis() ||
          blocked.some((b) => start < b.end && start + durationMs > b.start)
        ) {
          continue
        }
        if (request?.exact && start === requestedMs) {
          requestedFits = true
        } else if (index < horizonDays && count > 0) {
          if (start >= requestedMs) {
            preferred.push(start)
            if (preferred.length === count) break
          } else if (earlier.length < count) {
            earlier.push(start)
          }
        }
      }
    }
    if (preferred.length === count) break
    day = nextDay
  }

  const selected = [...earlier.slice(0, count - preferred.length), ...preferred]
  return {
    requestedFits,
    openings: selected.map((start) => ({
      startUtc: DateTime.fromMillis(start, { zone: 'utc' }).toISO()!,
      endUtc: DateTime.fromMillis(start + durationMs, { zone: 'utc' }).toISO()!,
    })),
  }
}
