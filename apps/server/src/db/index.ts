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
