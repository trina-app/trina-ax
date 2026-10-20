-- Component C: URLs an earlier web_fetch result of a chat showed (or the person allowed), so later turns of the same
-- chat may open them without a confirmation card (server/src/tools/url-gate.ts, design tab 7 "프롬프트 주입" ①).
-- Additive only.
CREATE TABLE chat_seen_urls (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  PRIMARY KEY (chat_id, url)
) WITHOUT ROWID;
