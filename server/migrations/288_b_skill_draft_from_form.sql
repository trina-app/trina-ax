-- min_compatible_reader: 1
-- Component B: a team skill drafted from a form in the team folder (docs/DECISIONS.md "Setup 팀 파일: forms become
-- skills"; server/src/onboarding/skill-draft.ts startFormSkillDraft, onboarding/form-skill.ts).
--   onboarding_skill_drafts.source_path: the form's team path such a draft started from (the same form again finds its
--     unsaved draft by it); NULL for a draft from an answer. A form's draft has no source chat or message: its
--     source_chat_id and source_message_id are '' (the columns are NOT NULL and a table is never rebuilt), and its
--     material has kind 'form' (the form's text and path) instead of the answer's snapshot.
-- Additive only (reader 1): an older build ignores the column; a form's draft chat there still runs restricted (the row
-- marks it), its instructions fail on the material it does not know, and the turn ends with an error (fails closed).
-- Numbered 288: 287 (room_team_copies) is the highest on dev and on feat/setup-files-organize.
ALTER TABLE onboarding_skill_drafts ADD COLUMN source_path TEXT;
CREATE INDEX idx_onboarding_skill_drafts_source_path ON onboarding_skill_drafts(user_id, source_path) WHERE source_path IS NOT NULL;
