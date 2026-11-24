-- An edit or deletion identifies a Telegram message, not a request. Keep the
-- identifiers of every message in a debounced request, including its connection.
CREATE TABLE request_messages (
  request_id TEXT NOT NULL REFERENCES requests(id),
  connection_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (request_id, connection_id, chat_id, message_id)
) STRICT;
CREATE INDEX request_messages_lookup
  ON request_messages(connection_id, chat_id, message_id);
