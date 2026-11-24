import { describe, expect, it } from 'vitest'
import { FakeCalendar } from '../src/calendar/fake.js'
import { parseRequest } from '../src/parse/parser.js'
import {
  buildCard,
  planProposals,
  type ReplyBlock,
} from '../src/requests/cards.js'
import { loadShopConfig } from '../src/shop/config.js'

const shop = loadShopConfig()
const now = new Date('2026-11-24T05:00:00Z')
const date = '2026-12-05T11:00:00.000Z'

async function cardFor(
  text: string,
  calendar = new FakeCalendar(),
  block?: ReplyBlock,
) {
  const parsed = parseRequest(text, now, shop)
  const proposals = await planProposals(parsed, shop, calendar, now)
  return buildCard(
    {
      id: 'request-1',
      version: 1,
      customer_first_name: 'Ánna🌷',
      intent: parsed.intent,
      service_id: parsed.serviceId ?? null,
      requested_start_utc: parsed.startUtc ?? null,
      status: 'pending',
    },
    proposals,
    shop,
    block,
  )
}

describe('request cards', () => {
  it('shows the service, local date, duration and smart default for a free slot', async () => {
    const card = await cardFor('Skin fade Sat 5 Dec at 3pm')
    expect(card.lines).toEqual([
      'Anna · Skin fade',
      'Sat 5 Dec · 15:00 · ● free (45 min)',
    ])
    expect(card.actions.map((action) => action.label)).toEqual([
      'Book & reply',
      'Offer Sat 5 Dec 15:15',
      'Not now',
    ])
  })

  it('offers two buffered alternatives after a taken slot beyond the current week', async () => {
    const calendar = new FakeCalendar()
    calendar.addForeignEvent({ startUtc: date, endUtc: '2026-12-05T11:45:00Z' })
    const card = await cardFor('Skin fade Sat 5 Dec at 3pm', calendar)
    expect(card.lines[1]).toBe('Sat 5 Dec · 15:00 · ○ taken')
    expect(card.actions.map((action) => action.label)).toEqual([
      'Offer Sat 5 Dec 16:00',
      'Offer Sat 5 Dec 16:15',
      'Ask for another time',
    ])
  })

  it.each([
    ['haircut please', 'Ask which day suits'],
    ['haircut on Saturday', 'Ask what time suits'],
  ])('asks for the missing detail in %s', async (phrase, label) => {
    const card = await cardFor(phrase)
    expect(card.actions.map((a) => a.label)).toEqual([
      label,
      'Offer earliest Tue 24 Nov 10:00',
      'Not now',
    ])
  })

  it.each([
    ['cancel my appointment', 'WANTS TO CANCEL'],
    ['good morning', 'NEEDS YOU'],
  ])('leaves %s with the owner', async (phrase, header) => {
    const card = await cardFor(phrase)
    expect(card.header).toBe(header)
    expect(card.actions.map((a) => a.label)).toEqual(['Not now'])
  })

  it('keeps a calendar failure visible and offers no booking', async () => {
    const calendar = new FakeCalendar()
    calendar.failures.calendarLevelError = true
    const card = await cardFor('Skin fade Sat 5 Dec at 3pm', calendar)
    expect(card.lines).toContain('Calendar unavailable')
    expect(card.actions.map((a) => a.label)).toEqual(['Not now'])
  })

  it.each(['rights', 'window'] as const)(
    'hides sending actions when blocked by %s',
    async (block) => {
      const calendar = new FakeCalendar()
      calendar.addForeignEvent({
        startUtc: date,
        endUtc: '2026-12-05T11:45:00Z',
      })
      const card = await cardFor('Skin fade Sat 5 Dec at 3pm', calendar, block)
      expect(card.header).toBe("CAN'T REPLY")
      expect(card.actions).toEqual([{ id: 'not_now', label: 'Not now' }])
    },
  )
})
