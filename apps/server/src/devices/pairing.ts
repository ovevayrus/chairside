import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Uppercase letters and digits without the look-alikes O, 0, I and 1. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 6
export const CODE_TTL_MS = 10 * 60_000
export const PAIR_ATTEMPTS_PER_MINUTE = 5

export type PairStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'paired'; deviceToken?: string }

export interface PairingOptions {
  db: DatabaseSync
  shopId: string
  /** Server secret mixed into every stored token hash. */
  pepper: string
  now?: () => Date
}

export function hashToken(pepper: string, token: string): string {
  return createHash('sha256').update(`${pepper}|${token}`).digest('hex')
}

function hashNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex')
}

function newCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

interface CodeRow {
  code: string
  expires_at: string
  shop_id: string | null
  consumed_at: string | null
}

/**
 * Pairing state lives in `pair_codes`: `shop_id` is set when the owner binds a
 * code, `consumed_at` when the device collected its token. The token is made
 * at collection time, so no plaintext token is ever stored.
 */
export class PairingService {
  readonly #db: DatabaseSync
  readonly #shopId: string
  readonly #pepper: string
  readonly #now: () => Date

  constructor(options: PairingOptions) {
    if (!options.pepper) throw new Error('Device token pepper is required')
    this.#db = options.db
    this.#shopId = options.shopId
    this.#pepper = options.pepper
    this.#now = options.now ?? (() => new Date())
  }

  start(deviceNonce: string): { code: string; expiresAt: string } {
    const nonceHash = hashNonce(deviceNonce)
    const expiresAt = new Date(this.#now().getTime() + CODE_TTL_MS)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      // A restarted pairing replaces the device's unbound codes.
      this.#db
        .prepare(
          'DELETE FROM pair_codes WHERE device_nonce=? AND shop_id IS NULL',
        )
        .run(nonceHash)
      const insert = this.#db.prepare(
        'INSERT INTO pair_codes (code, device_nonce, expires_at) VALUES (?, ?, ?)',
      )
      for (let attempt = 0; ; attempt++) {
        const code = newCode()
        // Replace a stale row holding the same code; a live one means retry.
        this.#db
          .prepare(
            'DELETE FROM pair_codes WHERE code=? AND expires_at<=? AND consumed_at IS NULL',
          )
          .run(code, this.#now().toISOString())
        try {
          insert.run(code, nonceHash, expiresAt.toISOString())
          this.#db.exec('COMMIT')
          return { code, expiresAt: expiresAt.toISOString() }
        } catch (error) {
          if (attempt >= 5) throw error
        }
      }
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Binds a live, unused code to this shop. False for unknown, expired or reused codes. */
  bind(code: string): boolean {
    const result = this.#db
      .prepare(
        'UPDATE pair_codes SET shop_id=? WHERE code=? AND shop_id IS NULL AND consumed_at IS NULL AND expires_at>?',
      )
      .run(this.#shopId, code, this.#now().toISOString())
    return Number(result.changes) === 1
  }

  /** Returns the token exactly once, on the first poll after the owner paired. */
  status(deviceNonce: string): PairStatus {
    const row = this.#db
      .prepare(
        'SELECT code, expires_at, shop_id, consumed_at FROM pair_codes WHERE device_nonce=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(hashNonce(deviceNonce)) as CodeRow | undefined
    if (!row) return { status: 'expired' }
    if (!row.shop_id) {
      return Date.parse(row.expires_at) > this.#now().getTime()
        ? { status: 'pending' }
        : { status: 'expired' }
    }
    if (row.consumed_at) return { status: 'paired' }
    const token = randomBytes(32).toString('base64url')
    const now = this.#now().toISOString()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const claimed = this.#db
        .prepare(
          'UPDATE pair_codes SET consumed_at=? WHERE code=? AND consumed_at IS NULL',
        )
        .run(now, row.code)
      if (Number(claimed.changes) !== 1) {
        this.#db.exec('ROLLBACK')
        return { status: 'paired' }
      }
      this.#db
        .prepare(
          'INSERT INTO devices (id, shop_id, token_hash, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          randomBytes(12).toString('hex'),
          row.shop_id,
          hashToken(this.#pepper, token),
          now,
        )
      this.#db.exec('COMMIT')
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    }
    return { status: 'paired', deviceToken: token }
  }

  /** The shop a device token belongs to, or null. */
  authenticate(token: string): string | null {
    const row = this.#db
      .prepare('SELECT id, shop_id FROM devices WHERE token_hash=?')
      .get(hashToken(this.#pepper, token)) as
      { id: string; shop_id: string } | undefined
    if (!row) return null
    this.#db
      .prepare('UPDATE devices SET last_seen_at=? WHERE id=?')
      .run(this.#now().toISOString(), row.id)
    return row.shop_id
  }
}
