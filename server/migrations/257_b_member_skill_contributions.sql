-- min_compatible_reader: 1
-- Component B: members contribute their own skills (docs/DECISIONS.md "MC"; server/src/skills/suggestions.ts). Additive
-- only. A member's suggestion ("스킬로 제안") may now carry one skill folder from their own computer, picked in the
-- browser and checked again by the server, sent with others as one batch.
--   skill_suggestions.source_detail: 'folder' for such a suggestion. The source_kind column's CHECK knows only message
--     and file, and tables are never rebuilt, so such a row keeps 'file' there (source_ref NULL) and its real kind here.
--     An older build reads it as a suggestion from a file: approving it there writes the SKILL.md body as one file.
--   skill_suggestions.batch_id: the one send it came with (one Inbox line per batch for the owners and admins).
--   skill_suggestions.folder_info: JSON, what the review shows of the folder (app, title, the files and their sizes,
--     scripts left out, a path on the member's computer, a team skill of the same name); never a file's content.
--   skill_suggestion_files: the folder's files as the server kept them (SKILL.md with its header made valid, text files
--     and small images; never a script, never a skill with a secret: those are refused before anything is stored),
--     outside the team files until an owner or admin approves; deleted on approve and reject, and with the suggestion.
-- Numbered 257: 252, 254 and 255 are reserved by other branches and 256 may be taken for session markers.
ALTER TABLE skill_suggestions ADD COLUMN source_detail TEXT;
ALTER TABLE skill_suggestions ADD COLUMN batch_id TEXT;
ALTER TABLE skill_suggestions ADD COLUMN folder_info TEXT;
CREATE INDEX skill_suggestions_batch ON skill_suggestions (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX skill_suggestions_suggester ON skill_suggestions (suggester_id, status);

CREATE TABLE skill_suggestion_files (
  suggestion_id TEXT NOT NULL REFERENCES skill_suggestions(id) ON DELETE CASCADE,
  -- a path inside the skill folder ("SKILL.md", "templates/quote.md"), checked by skills/share-check.ts
  path TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (suggestion_id, path)
);
