-- min_compatible_reader: 1
-- Component B: the depth a chat and a turn ran with, and the models that really answered a turn
-- (docs/AGENTS/plan/20261126-0420-model-effort-choice.md, docs/decisions/20261126-model-effort-choice.md).
-- 456: 454 is the highest b on dev and open PR #586 takes 455.
-- Additive only (reader 1): an older build ignores the columns and the table, and shows usage by turns.model as before.
--
-- chats.effort / turns.effort: 'quick' | 'normal' | 'thorough'; NULL = not chosen (보통, the model's own default).
-- turns.model stays the model that was asked for (a queued turn rebuilt after a restart runs with it).
-- turn_models: one row per turn and model that answered, with its tokens. source 'proxy' = counted by the model proxy
-- (authoritative: its first row of a turn replaces the turn's engine rows, credentials/broker.ts), 'engine' = the
-- engine's own report of a turn the proxy counted nothing of (chat/turn.ts). Never both for one turn.
ALTER TABLE chats ADD COLUMN effort TEXT;
ALTER TABLE turns ADD COLUMN effort TEXT;
CREATE TABLE turn_models (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('proxy', 'engine')),
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, model)
);
