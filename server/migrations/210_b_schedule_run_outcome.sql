-- min_compatible_reader: 1
-- Component B: the result of a scheduled run, separate from "the run ended" (turns.status). Written by the turn
-- before its terminal status (server/src/chat/schedule-outcome.ts): 'succeeded', 'problems' (the answer finished but
-- a tool call was refused or failed), 'failed' (the turn errored, stopped or gave no answer). NULL on older rows and
-- rows written by older builds: readers fall back to the status. Additive only.
ALTER TABLE turns ADD COLUMN run_outcome TEXT CHECK(run_outcome IS NULL OR run_outcome IN ('succeeded','problems','failed'));
