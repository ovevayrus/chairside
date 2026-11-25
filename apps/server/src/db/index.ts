import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// The workspace's tsc build leaves SQL assets in src/db.
const migrations = [
  { version: 1, file: new URL('../../src/db/schema.sql', import.meta.url) },
  {
    version: 2,
    file: new URL('../../src/db/002-request-messages.sql', import.meta.url),
  },
]

export function runMigrations(db: DatabaseSync): void {
  // Take the write lock before checking versions so concurrent opens serialize.
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `)
    const applied = db.prepare(
      'SELECT 1 FROM schema_migrations WHERE version = ?',
    )
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (const { version, file } of migrations) {
      if (applied.get(version)) continue
      db.exec(readFileSync(file, 'utf8'))
      record.run(version, new Date().toISOString())
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Throws if the database already holds a shop of the other mode. TEST MODE
 * fakes must never share a file with a live shop: processed update ids are
 * global, so a fake update could make Chairside skip a real one.
 */
export function assertSingleMode(db: DatabaseSync, mode: 'live' | 'test'): void {
  const other = mode === 'live' ? 'test' : 'live'
  if (!db.prepare('SELECT 1 AS hit FROM shops WHERE mode = ?').get(other)) return
  throw new Error(
    mode === 'test'
      ? 'This database holds a live shop: give TEST MODE its own DATABASE_PATH'
      : 'This database holds a TEST MODE shop: TEST MODE needs its own DATABASE_PATH; remove the TEST MODE shop from this file',
  )
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `)
    runMigrations(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
