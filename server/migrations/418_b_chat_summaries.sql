-- min_compatible_reader: 1
-- Component B: the summary of the older part of a chat a fresh engine session gets (chat/history-summary.ts,
-- docs/decisions/20261118-limits-context-summary.md). One row per summary: the person whose turn it was made for
-- (user_id; in a shared chat each person has their own), how many messages of the branch from the start it stands for
-- (covered_count) and the hash chain value of exactly those lines as that person saw them (covered_hash: a different
-- branch or a changed view never matches). model / tokens / cost / ms: what the call took. At most a few per chat and
-- person (older ones are deleted). New table only (reader 1): an older build never reads it.
CREATE TABLE chat_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  covered_count INTEGER NOT NULL,
  covered_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_summaries_chat_user ON chat_summaries (chat_id, user_id, covered_count);
