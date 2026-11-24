import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FakeCalendar } from '../src/calendar/fake.js'
import { openDatabase } from '../src/db/index.js'
import { createPrivacyRuntime } from '../src/privacy/commands.js'
import { loadShopConfig } from '../src/shop/config.js'
import type { ChatMessageEvent } from '../src/telegram/events.js'
import { FakeTelegramAdapter } from '../src/telegram/fake.js'

const owner = 101
const customer = 202
const now = '2026-12-03T08:00:00.000Z'
const later = '2026-12-03T09:00:00.000Z'
const debounceMs = 15

function seedRequest(
  db: DatabaseSync,
  id: string,
  shopId: string,
  chatId: number,
) {
  db.prepare(
    `INSERT INTO requests
    (id, shop_id, chat_id, customer_first_name, intent, status, last_customer_msg_at, created_at, updated_at)
    VALUES (?, ?, ?, 'Anna', 'book', 'booked', ?, ?, ?)`,
  ).run(id, shopId, chatId, now, now, now)
  db.prepare('INSERT INTO request_messages VALUES (?, ?, ?, ?)').run(
    id,
    '',
    chatId,
    1,
  )
  db.prepare(
    `INSERT INTO offers (id, request_id, chat_id, slot_start_utc, slot_end_utc, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
  ).run(id, id, chatId, now, later, later)
  db.prepare(
    `INSERT INTO actions (id, request_id, version, action_id, idempotency_key, state, created_at, updated_at)
    VALUES (?, ?, 1, 'book', ?, 'sent', ?, ?)`,
  ).run(id, id, id, now, now)
  db.prepare(`INSERT INTO bookings VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`).run(
    id,
    shopId,
    id,
    'calendar-event',
    now,
    later,
    now,
  )
  db.prepare(
    `INSERT INTO proposals (id, request_id, version, kind, label)
    VALUES (?, ?, 1, 'book', 'Book')`,
  ).run(id, id)
}

async function fixture(business = false) {
  const db = openDatabase(':memory:')
  const onError = vi.fn()
  const telegram = new FakeTelegramAdapter(onError)
  const reply = vi.spyOn(telegram, 'sendText')
  const disconnectDevices = vi.fn()
  const calendar = new FakeCalendar()
  const calendarEvent = calendar.addForeignEvent({
    id: 'calendar-event',
    startUtc: now,
    endUtc: later,
  })
  const runtime = createPrivacyRuntime(
    {
      db,
      telegram,
      calendar,
      shopId: 'shop',
      shop: loadShopConfig(),
      mode: 'test',
      business,
      now: () => new Date(now),
      debounceMs,
    },
    (userId) => userId === owner,
    disconnectDevices,
  )
  onTestFinished(() => {
    runtime.pipeline.close()
    db.close()
  })
  await runtime.ready
  db.prepare(
    `INSERT INTO shops (id, name, timezone, config_json, mode, updated_at)
    VALUES ('other', 'Other', 'UTC', '{}', 'test', ?)`,
  ).run(now)
  for (const shop of ['shop', 'other']) {
    db.prepare(
      'INSERT INTO devices (id, shop_id, token_hash, created_at) VALUES (?,?,?,?)',
    ).run(shop, shop, shop, now)
    db.prepare(
      'INSERT INTO pair_codes (code, device_nonce, expires_at, shop_id) VALUES (?,?,?,?)',
    ).run(shop, shop, later, shop)
    db.prepare(
      "INSERT INTO consents (id, shop_id, kind, granted_at) VALUES (?,?,'test',?)",
    ).run(shop, shop, now)
  }
  db.prepare(
    "INSERT INTO pair_codes (code, device_nonce, expires_at) VALUES ('unbound','unbound',?)",
  ).run(later)
  seedRequest(db, 'first', 'shop', customer)
  seedRequest(db, 'second', 'shop', customer)
  seedRequest(db, 'neighbor', 'shop', customer + 1)
  seedRequest(db, 'another-shop', 'other', customer)

  let sequence = 900
  function message(
    text: string,
    chatId: number,
    changes: Partial<ChatMessageEvent> = {},
  ) {
    const id = sequence++
    return telegram.emit({
      type: 'message',
      updateId: id,
      messageId: id,
      text,
      chatId,
      fromId: chatId,
      firstName: 'Anna',
      direction: 'incoming',
      dateIso: now,
      ...changes,
    })
  }
  function checkRequests(expected: string[]) {
    for (const table of [
      'offers',
      'request_messages',
      'actions',
      'bookings',
      'proposals',
      'requests',
    ]) {
      const column = table === 'requests' ? 'id' : 'request_id'
      const rows = db
        .prepare(`SELECT ${column} AS id FROM ${table} ORDER BY id`)
        .all()
      expect(
        rows.map((row) => row.id),
        table,
      ).toEqual(expected)
    }
  }
  function checkShops(expected: string[]) {
    for (const table of ['devices', 'consents', 'pair_codes', 'shops']) {
      const column = table === 'shops' ? 'id' : 'shop_id'
      const rows = db
        .prepare(
          `SELECT ${column} AS id FROM ${table} WHERE ${column} IS NOT NULL ORDER BY id`,
        )
        .all()
      expect(
        rows.map((row) => row.id),
        table,
      ).toEqual(expected)
    }
    expect(
      db.prepare("SELECT shop_id FROM pair_codes WHERE code='unbound'").get(),
    ).toEqual({ shop_id: null })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
  return {
    db,
    message,
    checkRequests,
    checkShops,
    reply,
    calendar,
    calendarEvent,
    onError,
    runtime,
    disconnectDevices,
  }
}

it('/forget deletes only the requesting customer in this shop, including pending input', async () => {
  const f = await fixture()
  await f.message('Haircut Saturday', customer)
  await f.message('/forget', customer, { updateId: 1000 })
  await delay(debounceMs * 2)
  f.checkRequests(['another-shop', 'neighbor'])
  f.checkShops(['other', 'shop'])
  expect(f.reply.mock.calls).toEqual([
    [customer, 'Your booking data was deleted.'],
  ])
  expect(await f.calendar.getEvent('calendar-event')).toEqual(f.calendarEvent)

  seedRequest(f.db, 'new-booking', 'shop', customer)
  await f.message('/forget', customer, { updateId: 1000 })
  f.checkRequests(['another-shop', 'neighbor', 'new-booking'])
  expect(f.reply).toHaveBeenCalledTimes(1)
  expect(f.disconnectDevices).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it('the owner can delete all shop rows while the calendar event and other shop survive', async () => {
  const f = await fixture()
  await f.message('Haircut Saturday', customer)
  await f.message('/delete_my_data', owner)
  await delay(debounceMs * 2)
  f.checkRequests(['another-shop'])
  f.checkShops(['other'])
  expect(f.reply.mock.calls).toEqual([[owner, 'Your shop data was deleted.']])
  expect(await f.calendar.getEvent('calendar-event')).toEqual(f.calendarEvent)
  expect(f.disconnectDevices).toHaveBeenCalledOnce()
  expect(f.onError).not.toHaveBeenCalled()
})

it('ignores non-owner shop deletion, business-chat commands, and edited commands silently', async () => {
  const f = await fixture()
  await f.message('/delete_my_data', customer)
  await f.message('/delete_my_data', owner, { connectionId: 'business' })
  await f.message('/delete_my_data', owner, { type: 'edited' })
  await f.message('/forget', customer, { fromId: owner })
  await f.message('/forget', customer, { connectionId: 'business' })
  await delay(debounceMs * 2)
  f.checkRequests(['another-shop', 'first', 'neighbor', 'second'])
  f.checkShops(['other', 'shop'])
  expect(f.db.prepare('SELECT * FROM processed_updates').all()).toEqual([])
  expect(f.reply).not.toHaveBeenCalled()
  expect(f.onError).not.toHaveBeenCalled()
})

it('permits the owner command but not customer /forget in Business mode', async () => {
  const f = await fixture(true)
  await f.message('/forget', customer)
  f.checkRequests(['another-shop', 'first', 'neighbor', 'second'])
  expect(f.reply).not.toHaveBeenCalled()
  await f.message('/delete_my_data', owner)
  f.checkRequests(['another-shop'])
  f.checkShops(['other'])
  expect(f.reply.mock.calls).toEqual([[owner, 'Your shop data was deleted.']])
})

it('rolls a failed deletion back and allows the same update to retry', async () => {
  const f = await fixture()
  f.db.exec(
    "CREATE TEMP TRIGGER refuse BEFORE DELETE ON bookings BEGIN SELECT RAISE(ABORT,'test'); END",
  )
  await f.message('/forget', customer, { updateId: 1000 })
  f.checkRequests(['another-shop', 'first', 'neighbor', 'second'])
  expect(f.onError).toHaveBeenCalledTimes(1)
  expect(f.reply).not.toHaveBeenCalled()
  f.db.exec('DROP TRIGGER refuse')
  await f.message('/forget', customer, { updateId: 1000 })
  f.checkRequests(['another-shop', 'neighbor'])
  expect(f.reply).toHaveBeenCalledTimes(1)
})

it('finishes in-flight writes before /forget, then accepts later messages', async () => {
  const f = await fixture()
  let releaseCalendar!: () => void
  const blocked = new Promise<void>((resolve) => {
    releaseCalendar = resolve
  })
  const read = vi
    .spyOn(f.calendar, 'freeBusy')
    .mockImplementationOnce(async () => {
      await blocked
      return { ok: true, busy: [] }
    })
  await f.message('Skin fade Saturday at 3pm', customer)
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  const erased = f.message('/forget', customer)
  const laterMessage = f.message('Haircut Saturday', customer, {
    firstName: 'Later',
  })
  // Let the deletion attempt reach the store lock while free/busy is in flight.
  await delay(debounceMs * 2)
  expect(f.reply).not.toHaveBeenCalled()
  releaseCalendar()
  await Promise.all([erased, laterMessage])
  await vi.waitFor(() =>
    expect(
      f.db
        .prepare(
          'SELECT customer_first_name FROM requests WHERE shop_id=? AND chat_id=?',
        )
        .all('shop', customer),
    ).toEqual([{ customer_first_name: 'Later' }]),
  )
  expect(f.reply).toHaveBeenCalledTimes(1)
  expect(f.onError).not.toHaveBeenCalled()
})
