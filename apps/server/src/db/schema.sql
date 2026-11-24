-- Migration 1. All timestamps are ISO-8601 UTC strings.
CREATE TABLE shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  owner_tg_user_id INTEGER,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  business_connection_id TEXT,
  connection_enabled INTEGER NOT NULL DEFAULT 0 CHECK (connection_enabled IN (0, 1)),
  rights_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rights_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;

CREATE TABLE pair_codes (
  code TEXT PRIMARY KEY,
  device_nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  shop_id TEXT REFERENCES shops(id),
  consumed_at TEXT
) STRICT;

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  chat_id INTEGER NOT NULL,
  customer_first_name TEXT NOT NULL,
  intent TEXT NOT NULL,
  service_id TEXT,
  requested_start_utc TEXT,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_customer_msg_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL CHECK (version >= 0),
  kind TEXT NOT NULL,
  slot_start_utc TEXT,
  slot_end_utc TEXT,
  label TEXT NOT NULL
) STRICT;

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  chat_id INTEGER NOT NULL,
  slot_start_utc TEXT NOT NULL,
  slot_end_utc TEXT NOT NULL,
  offer_message_id INTEGER,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX offers_one_active_per_chat ON offers(chat_id) WHERE status = 'active';

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL CHECK (version >= 0),
  action_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  planned_event_id TEXT,
  telegram_message_id INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_id, version, action_id)
) STRICT;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  request_id TEXT NOT NULL REFERENCES requests(id),
  calendar_event_id TEXT NOT NULL,
  slot_start_utc TEXT NOT NULL,
  slot_end_utc TEXT NOT NULL,
  reply_status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  kind TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
