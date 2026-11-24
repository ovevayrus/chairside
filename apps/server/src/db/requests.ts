import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Card } from '@chairside/shared'
import type { ParseResult } from '../parse/parser.js'
import { buildCard, proposal, type Proposal } from '../requests/cards.js'
import type { ShopConfig } from '../shop/config.js'
import type { BusinessRights, ConnectionEvent } from '../telegram/events.js'

export interface RequestRow {
  id: string
  shop_id: string
  chat_id: number
  customer_first_name: string
  intent: string
  service_id: string | null
  requested_start_utc: string | null
  status: string
  version: number
  last_customer_msg_at: string
  created_at: string
  updated_at: string
}

export interface StoreOptions {
  db: DatabaseSync
  shopId: string
  shop: ShopConfig
  mode: 'live' | 'test'
  business?: boolean
  now?: () => Date
}

interface RequestInput {
  id?: string
  chatId: number
  firstName: string
  parsed: ParseResult
  lastCustomerMsgAt: string
  connectionId: string
  messageIds: number[]
  proposals: Proposal[]
}

export class RequestStore {
  readonly db: DatabaseSync
  readonly shopId: string
  readonly shop: ShopConfig
  readonly mode: 'live' | 'test'
  readonly business: boolean
  readonly now: () => Date
  private tail: Promise<void> = Promise.resolve()

  constructor(options: StoreOptions) {
    this.db = options.db
    this.shopId = options.shopId
    this.shop = options.shop
    this.mode = options.mode
    this.business = options.business ?? true
    this.now = options.now ?? (() => new Date())
    const existing = this.db
      .prepare('SELECT mode FROM shops WHERE id = ?')
      .get(this.shopId)
    if (existing && existing.mode !== this.mode)
      throw new Error('Shop mode mismatch')
    this.db
      .prepare(
        `INSERT INTO shops (id,name,timezone,config_json,mode,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
      timezone=excluded.timezone,config_json=excluded.config_json,updated_at=excluded.updated_at`,
      )
      .run(
        this.shopId,
        this.shop.name,
        this.shop.timezone,
        JSON.stringify(this.shop),
        this.mode,
        this.now().toISOString(),
      )
    // The edited text was intentionally volatile. After a restart let the owner
    // inspect the chat, without re-offering an action from the obsolete version.
    this.transaction(() => {
      const interrupted = this.db
        .prepare(
          "SELECT id FROM requests WHERE shop_id=? AND status='updating'",
        )
        .all(this.shopId)
      for (const { id } of interrupted) {
        this.db
          .prepare(
            "UPDATE requests SET status='pending',intent='unknown',requested_start_utc=NULL,version=version+1 WHERE id=?",
          )
          .run(String(id))
        this.insertProposals(this.get(String(id))!, [
          proposal('not_now', 'Not now'),
        ])
      }
    })
  }

  // Exactly one store is shared by this shop's ingress, REST and reconciliation.
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn)
    this.tail = task.then(
      () => {},
      () => {},
    )
    return task
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  claim(updateId: number): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO processed_updates VALUES (?,?)')
        .run(updateId, this.now().toISOString()).changes === 1
    )
  }

  connection() {
    const row = this.db
      .prepare(
        'SELECT business_connection_id,owner_tg_user_id,connection_enabled,rights_json FROM shops WHERE id=?',
      )
      .get(this.shopId)!
    const rights = JSON.parse(
      String(row.rights_json),
    ) as Partial<BusinessRights>
    return {
      id: row.business_connection_id as string | null,
      ownerId: row.owner_tg_user_id as number | null,
      enabled: row.connection_enabled === 1,
      rights: {
        canReply: rights.canReply === true,
        canReadMessages: rights.canReadMessages === true,
        canDeleteSentMessages: rights.canDeleteSentMessages === true,
        canDeleteAllMessages: rights.canDeleteAllMessages === true,
      },
    }
  }

  setConnection(event: Omit<ConnectionEvent, 'type' | 'updateId'>) {
    this.db
      .prepare(
        `UPDATE shops SET business_connection_id=?,owner_tg_user_id=?,
      connection_enabled=?,rights_json=?,updated_at=? WHERE id=?`,
      )
      .run(
        event.connectionId,
        event.ownerUserId,
        Number(event.isEnabled),
        JSON.stringify(event.rights),
        this.now().toISOString(),
        this.shopId,
      )
  }

  pending(chatId?: number): RequestRow[] {
    const sql =
      "SELECT * FROM requests WHERE shop_id=? AND status IN ('pending','send_failed','reply_not_sent','reply_unknown','slot_taken_accepted')"
    const order = ' ORDER BY created_at,rowid'
    return (chatId === undefined
      ? this.db.prepare(sql + order).all(this.shopId)
      : this.db
          .prepare(sql + ' AND chat_id=?' + order)
          .all(this.shopId, chatId)) as unknown as RequestRow[]
  }

  get(id: string): RequestRow | undefined {
    return this.db
      .prepare('SELECT * FROM requests WHERE shop_id=? AND id=?')
      .get(this.shopId, id) as unknown as RequestRow | undefined
  }

  forMessage(
    connectionId: string,
    chatId: number,
    messageId: number,
  ): RequestRow | undefined {
    return this.db
      .prepare(
        `SELECT r.* FROM requests r JOIN request_messages m ON r.id=m.request_id
      WHERE r.shop_id=? AND m.connection_id=? AND m.chat_id=? AND m.message_id=?
      ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`,
      )
      .get(this.shopId, connectionId, chatId, messageId) as unknown as
      RequestRow | undefined
  }

  lastMessage(id: string) {
    return this.db
      .prepare(
        'SELECT connection_id,message_id FROM request_messages WHERE request_id=? ORDER BY message_id DESC LIMIT 1',
      )
      .get(id) as { connection_id: string; message_id: number } | undefined
  }

  save(input: RequestInput): RequestRow {
    const { firstName, parsed, chatId, lastCustomerMsgAt } = input
    const id = input.id ?? randomUUID()
    const ts = this.now().toISOString()
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO requests (id,shop_id,chat_id,customer_first_name,intent,service_id,
        requested_start_utc,status,version,last_customer_msg_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',1,?,?,?) ON CONFLICT(id) DO UPDATE SET
        customer_first_name=excluded.customer_first_name,intent=excluded.intent,service_id=excluded.service_id,
        requested_start_utc=excluded.requested_start_utc,status='pending',version=requests.version+1,
        last_customer_msg_at=max(requests.last_customer_msg_at,excluded.last_customer_msg_at),updated_at=excluded.updated_at`,
        )
        .run(
          id,
          this.shopId,
          chatId,
          firstName,
          parsed.intent,
          parsed.serviceId ?? null,
          parsed.startUtc ?? null,
          lastCustomerMsgAt,
          ts,
          ts,
        )
      const row = this.get(id)!
      this.insertProposals(row, input.proposals)
      const message = this.db.prepare(
        'INSERT OR IGNORE INTO request_messages VALUES (?,?,?,?)',
      )
      for (const messageId of input.messageIds)
        message.run(id, input.connectionId, chatId, messageId)
      return row
    })
  }

  insertProposals(row: RequestRow, proposals: Proposal[]) {
    const stmt = this.db.prepare(
      'INSERT INTO proposals (id,request_id,version,kind,slot_start_utc,slot_end_utc,label) VALUES (?,?,?,?,?,?,?)',
    )
    for (const p of proposals)
      stmt.run(
        p.id,
        row.id,
        row.version,
        p.kind,
        p.slot_start_utc,
        p.slot_end_utc,
        p.label,
      )
  }

  proposals(row: RequestRow): Proposal[] {
    return this.db
      .prepare(
        'SELECT id,kind,slot_start_utc,slot_end_utc,label FROM proposals WHERE request_id=? AND version=? ORDER BY rowid',
      )
      .all(row.id, row.version) as unknown as Proposal[]
  }

  close(id: string, status: string) {
    this.db
      .prepare(
        'UPDATE requests SET status=?,version=version+1,updated_at=? WHERE id=? AND shop_id=?',
      )
      .run(status, this.now().toISOString(), id, this.shopId)
  }

  beginUpdate(id: string) {
    this.db
      .prepare(
        "UPDATE requests SET status='updating',updated_at=? WHERE shop_id=? AND id=?",
      )
      .run(this.now().toISOString(), this.shopId, id)
  }

  /** The batch did not update this request after all (it accepted an offer). */
  cancelUpdate(id: string) {
    this.db
      .prepare(
        "UPDATE requests SET status='pending',updated_at=? WHERE shop_id=? AND id=? AND status='updating'",
      )
      .run(this.now().toISOString(), this.shopId, id)
  }

  /** Records a later customer message for this request: ids and time only. */
  addMessages(
    row: RequestRow,
    connectionId: string,
    messageIds: number[],
    dateIso: string,
  ) {
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE requests SET last_customer_msg_at=max(last_customer_msg_at,?),updated_at=? WHERE shop_id=? AND id=?',
        )
        .run(dateIso, this.now().toISOString(), this.shopId, row.id)
      const message = this.db.prepare(
        'INSERT OR IGNORE INTO request_messages VALUES (?,?,?,?)',
      )
      for (const messageId of messageIds)
        message.run(row.id, connectionId, row.chat_id, messageId)
    })
  }

  replyBlock(row: RequestRow): 'rights' | 'window' | undefined {
    if (!this.business) return
    const c = this.connection()
    if (
      !c.id ||
      !c.enabled ||
      !c.rights.canReply ||
      this.lastMessage(row.id)?.connection_id !== c.id
    )
      return 'rights'
    if (
      this.now().getTime() - Date.parse(row.last_customer_msg_at) >=
      86_400_000
    )
      return 'window'
  }

  card(row: RequestRow, pending = this.pending()): Card {
    return buildCard(
      row,
      this.proposals(row),
      this.shop,
      this.replyBlock(row),
      Math.max(1, pending.findIndex((r) => r.id === row.id) + 1),
      Math.max(1, pending.length),
    )
  }
}
