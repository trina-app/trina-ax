-- min_compatible_reader: 1
-- Component B: a waiting call keeps what its replay needs (docs/decisions/20261122-late-card-answer-resumes.md,
-- server/src/chat/open-questions.ts). call_meta is JSON:
--   asked: the turn that asked for the call, its user message and its answer (the replay's checks of "the asker's own
--     message" and "made in this answer" read these, not the button's words of the answer message)
--   always: the kind of the card's "Always allow" (kept when the person picked it, even if the replay ends before that card)
--   prior: the answers the call's earlier cards already took (a call with two cards never asks the first one again)
-- 444: 442 (user_allowed_sites, #403) is the highest on dev and #403; 443 is taken by #409 (message_step_notes).
-- Additive only (reader 1): an older build ignores the column and replays as before.
ALTER TABLE open_questions ADD COLUMN call_meta TEXT;
