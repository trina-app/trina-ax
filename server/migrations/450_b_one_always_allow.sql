-- min_compatible_reader: 1
-- Component B: one "Always allow" (docs/decisions/20261123-one-always-allow.md; the owner, 2026-11-23: "그 대화에서만 항상
-- 허용이 아니라 그냥 전체 항상 허용이 있어야할 것 같은데"). No card offers or keeps an Always for one chat any more, so
-- the rows such choices left are removed: the chat_card_approvals kinds of "Always in this chat" (shared_connection,
-- shared_unsure_tool, shared_own_act, card_always; each lasted 12 hours at most) and every per-chat site of the address
-- card ("이 대화에서 이 사이트 허용", chat_allowed_sites, 324). None is turned into a permanent choice: that would widen
-- what the person chose. The person's permanent ones stay as they are (card_always_allow, connector_tool_allow,
-- user_allowed_sites, browser_site_grants, integration_user_allow); the next card offers "항상 허용".
-- 445: 444 (open_questions.call_meta) is the highest on dev.
-- Data only (reader 1): an older build reads the empty rows as "not allowed here" and asks, as before such a choice.
-- The table chat_allowed_sites stays (an older build still reads and writes it).
DELETE FROM chat_card_approvals WHERE kind IN ('shared_connection', 'shared_unsure_tool', 'shared_own_act', 'card_always');
DELETE FROM chat_allowed_sites;
