-- min_compatible_reader: 1
-- Component A: the hosting service's trial AI credit was removed (owner decision 2026-11-15, docs/DECISIONS.md
-- "Hosted trial AI credit removed"). Its two settings rows are read by nothing any more: ai.hostedChatKey (an
-- OpenRouter key of the hosting service's, encrypted with the credentials vault, with its dollar cap, end and switch)
-- and ai.hostedChatUsage (the dollars spent with it). The key goes with its row; secure_delete is not on for the live
-- database, so its encrypted bytes may stay in free pages until SQLite reuses them (they decrypt only with this
-- server's credentials key file). Turns it answered keep turns.credential_id 'hosted-trial' (usage history).
-- Data only (reader 1): an older build finds no key and answers as a team that never had one.
-- Numbered 124: 123 (a_guest_place_return) is the highest on dev.
DELETE FROM settings WHERE key IN ('ai.hostedChatKey', 'ai.hostedChatUsage');
