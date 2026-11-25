-- min_compatible_reader: 1
-- Component B: "what my group often asks" in the reader's language (docs/decisions/20261125-often-asked-reader-language.md).
-- often_asked_items.locale: the language a sentence is written in (the daily run asks the AI once per language people
-- read the app in). NULL: a row from before, written in the team's default language then; Home reads it as that.
-- 454: 452 is the highest b on dev and open PR #586 takes 453.
-- Additive only (reader 1): an older build ignores the column and shows every row as before.
ALTER TABLE often_asked_items ADD COLUMN locale TEXT;
