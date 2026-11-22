-- min_compatible_reader: 1
-- Component C: a page's versions say who asked for each one and which version a restore brought back
-- (server/src/tools/artifact.ts; scenario QA S-033). asked_by: the person (the turn's user for a version the AI made,
-- the person for a restore in the panel); NULL on older rows, which fall back to the turn of their message.
-- restored_from: the version a restore copied. 440: 438 is the highest on dev and in batch 20261122-i, and open PR #375
-- takes 439.
-- Additive only (reader 1): an older build never names the columns.
ALTER TABLE artifacts ADD COLUMN asked_by TEXT;
ALTER TABLE artifacts ADD COLUMN restored_from INTEGER;
