-- min_compatible_reader: 1
-- Component B: why an answer ended before the AI was done (docs/DECISIONS.md "Continue after the per-answer limit"):
-- 'tool_limit' (the per-answer limit of tool calls: Claude Code --max-turns, the API engine's rounds) or 'time_limit'
-- (20 active minutes, or the total time). The answer and the turn stay 'done' (not an error, not a stop by the
-- person); the chat offers "continue" and the next turn tells the AI where it stopped. NULL: a normal end, and every
-- row written before this column. Older builds never read it. Additive only.
ALTER TABLE messages ADD COLUMN stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN ('tool_limit','time_limit'));
ALTER TABLE turns ADD COLUMN stop_reason TEXT CHECK(stop_reason IS NULL OR stop_reason IN ('tool_limit','time_limit'));
