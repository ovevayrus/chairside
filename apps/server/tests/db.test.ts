import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertSingleMode, openDatabase } from '../src/db/index.js'

let directory: string
let path: string
let db: DatabaseSync
const now = new Date().toISOString()

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'chairside-db-'))
  path = join(directory, 'shop.sqlite')
  db = openDatabase(path)
})

afterEach(() => {
  if (db?.isOpen) db.close()
  rmSync(directory, { recursive: true, force: true })
})

function insertRequest() {
  db.prepare(
    `INSERT INTO shops
       (id, name, timezone, config_json, owner_tg_user_id, mode, updated_at)
     VALUES ('shop-1', 'Shop', 'UTC', '{}', 101, 'test', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO requests
       (id, shop_id, chat_id, customer_first_name, intent, status, version,
        last_customer_msg_at, created_at, updated_at)
     VALUES ('request-1', 'shop-1', 201, 'Lee', 'book', 'pending', 1, ?, ?, ?)`,
  ).run(now, now, now)
}

it('keeps TEST MODE and live shops in separate databases', () => {
  // An empty database serves either mode.
  expect(() => assertSingleMode(db, 'live')).not.toThrow()
  expect(() => assertSingleMode(db, 'test')).not.toThrow()
  insertRequest() // shop-1 in TEST MODE
  expect(() => assertSingleMode(db, 'test')).not.toThrow()
  expect(() => assertSingleMode(db, 'live')).toThrow(
    /holds a TEST MODE shop: TEST MODE needs its own DATABASE_PATH; remove the TEST MODE shop/,
  )
  db.prepare("UPDATE shops SET mode = 'live'").run()
  expect(() => assertSingleMode(db, 'live')).not.toThrow()
  expect(() => assertSingleMode(db, 'test')).toThrow(
    /holds a live shop: give TEST MODE its own DATABASE_PATH/,
  )
})

it('opens a WAL database with every section 4.2 table and column', () => {
  const columnsByTable = {
    shops:
      'id name timezone config_json owner_tg_user_id mode business_connection_id connection_enabled rights_json updated_at',
    devices: 'id shop_id token_hash created_at last_seen_at',
    pair_codes: 'code device_nonce expires_at shop_id consumed_at',
    requests:
      'id shop_id chat_id customer_first_name intent service_id requested_start_utc status version last_customer_msg_at created_at updated_at booking_id',
    proposals: 'id request_id version kind slot_start_utc slot_end_utc label',
    offers:
      'id request_id chat_id slot_start_utc slot_end_utc offer_message_id status expires_at booking_id',
    actions:
      'id request_id version action_id idempotency_key state planned_event_id telegram_message_id result_json created_at updated_at',
    bookings:
      'id shop_id request_id calendar_event_id slot_start_utc slot_end_utc reply_status created_at status service_id replaced_booking_id cleanup_pending pending_action_id',
    processed_updates: 'update_id received_at',
    consents: 'id shop_id kind granted_at revoked_at',
    schema_migrations: 'version applied_at',
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()
    .map((row) => row.name)
  expect(tables).toEqual(expect.arrayContaining(Object.keys(columnsByTable)))
  const readColumns = db.prepare('SELECT name FROM pragma_table_xinfo(?)')
  for (const [table, expected] of Object.entries(columnsByTable)) {
    const names = readColumns.all(table).map((row) => row.name)
    expect(names.sort(), table).toEqual(expected.split(' ').sort())
  }
  expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
  expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1)
  expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(5000)
})

it('has no columns for customer message text in any table', () => {
  const forbidden = db.prepare(`
    SELECT t.name AS table_name, c.name AS column_name
    FROM sqlite_schema AS t, pragma_table_xinfo(t.name) AS c
    WHERE t.type = 'table'
      AND lower(c.name) IN ('text', 'body', 'message', 'content', 'caption')
  `)
  expect(forbidden.all()).toEqual([])
})

it('preserves migration 1 and existing data when reopened', () => {
  const appliedAt = '2000-01-01T00:00:00.000Z'
  expect(
    db
      .prepare('UPDATE schema_migrations SET applied_at = ? WHERE version = 1')
      .run(appliedAt).changes,
  ).toBe(1)
  db.prepare(
    'INSERT INTO processed_updates (update_id, received_at) VALUES (1, ?)',
  ).run(now)
  db.close()
  db = openDatabase(path)

  expect(
    db
      .prepare('SELECT applied_at FROM schema_migrations WHERE version = 1')
      .all(),
  ).toEqual([{ applied_at: appliedAt }])
  expect(
    db
      .prepare('SELECT received_at FROM processed_updates WHERE update_id = 1')
      .get(),
  ).toEqual({
    received_at: now,
  })
})

it('migrates an existing booking to active with its original service and reply state', () => {
  db.close()
  const legacyPath = join(directory, 'legacy.sqlite')
  db = new DatabaseSync(legacyPath)
  for (const file of ['schema.sql', '002-request-messages.sql']) {
    db.exec(readFileSync(new URL(`../src/db/${file}`, import.meta.url), 'utf8'))
  }
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES (1, '${now}'), (2, '${now}');
  `)
  insertRequest()
  db.prepare("UPDATE requests SET service_id='skin_fade'").run()
  db.prepare(
    `
    INSERT INTO bookings (id, shop_id, request_id, calendar_event_id, slot_start_utc, slot_end_utc, reply_status, created_at)
    VALUES ('legacy-booking', 'shop-1', 'request-1', 'legacy-event', ?, ?, 'sent', ?)
  `,
  ).run(now, new Date(Date.parse(now) + 45 * 60_000).toISOString(), now)
  db.close()
  db = openDatabase(legacyPath)

  expect(db.prepare('SELECT * FROM bookings').get()).toMatchObject({
    id: 'legacy-booking',
    calendar_event_id: 'legacy-event',
    status: 'active',
    service_id: 'skin_fade',
    reply_status: 'sent',
    cleanup_pending: 0,
    replaced_booking_id: null,
  })
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('rejects duplicate idempotency keys and duplicate request/version/action tuples', () => {
  insertRequest()
  const insert = db.prepare(`
    INSERT INTO actions
      (id, request_id, version, action_id, idempotency_key, state, created_at, updated_at)
    VALUES (?, 'request-1', ?, ?, ?, 'calendar_pending', ?, ?)
  `)
  insert.run('action-1', 1, 'book', 'first-tap', now, now)
  expect(() =>
    insert.run('action-2', 1, 'offer', 'first-tap', now, now),
  ).toThrow(/UNIQUE constraint failed: actions\.idempotency_key/)
  expect(() =>
    insert.run('action-3', 1, 'book', 'second-tap', now, now),
  ).toThrow(
    /UNIQUE constraint failed: actions\.request_id, actions\.version, actions\.action_id/,
  )
  expect(insert.run('action-4', 2, 'book', 'third-tap', now, now).changes).toBe(
    1,
  )
})

it('allows a new active offer for a chat once the previous offer expires', () => {
  insertRequest()
  const insert = db.prepare(`
    INSERT INTO offers
      (id, request_id, chat_id, slot_start_utc, slot_end_utc, offer_message_id, status, expires_at)
    VALUES (?, 'request-1', 201, ?, ?, ?, 'active', ?)
  `)
  const end = new Date(Date.parse(now) + 3_600_000).toISOString()
  insert.run('offer-1', now, end, 301, end)
  expect(() => insert.run('offer-2', now, end, 302, end)).toThrow(
    /UNIQUE constraint failed: offers\.chat_id/,
  )
  const expire = db.prepare("UPDATE offers SET status = 'expired' WHERE id = ?")
  expect(expire.run('offer-1').changes).toBe(1)
  expect(insert.run('offer-2', now, end, 302, end).changes).toBe(1)
})
