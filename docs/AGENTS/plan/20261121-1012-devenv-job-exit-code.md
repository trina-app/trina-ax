# Dev environment jobs: a job that ended by itself keeps its exit code (QA TC-6586)

- Date (UTC): 2026-11-21 10:12
- Branch: `fix/devenv-job-exit-code`
- Status: done
- Where: server/src/devenv (jobs.ts, srt/runner.ts), web inbox text. Why: a finished job was told as "couldn't finish"
- Version impact: patch (a bug fix in how a job's end is recorded and told; no API or schema change)

## Goal

On qa.trina.app (0.5.25-dev) a job `sleep 40 && echo done` wrote `done`, but its row has no exit code and
`end_reason = setting`, and qa-member heard "Trina couldn't finish the job". A job that exited 0 must always be told
as done; a job whose result is truly unknown must say so in plain words, not as a failure.

## Root cause (evidence from qa, read only)

- Rows of 10:02–10:06Z: `sleep40` and `sleep_test` (`exit 3`) ended with `exit_code NULL, end_reason setting`
  less than 3 s after their unit deactivated by itself; `sleep35` in another chat, which ended while `sleep_test`
  still ran, got `exit 0`. All three rows have the same access hash.
- `users/qa-member/skills` does not exist. Each run holds it as an empty placeholder (placeholders.ts
  holdSkillFolders) while it lives; the hash of a run is made while the placeholder is there. When the person's last
  run ends, the placeholder goes, and the next poll's `accessHash` (personView keeps only folders that exist) differs.
- pollRuns checks the access hash (and the network) **before** it reads the exit file: so a run that already ended
  by itself is "stopped" for `setting`; stopRow removes its exit file and records no code.
- A second, smaller window: rowStatus reads the exit file, then asks systemd; a run that ends between the two is
  "inactive" with no code read, and ends `lost`.

## Steps

1. runner.ts stopRow: a run whose exit file is there ended by itself: end it with that code (`exit`), do not stop it.
2. runner.ts rowStatus: when the unit is no longer running, read the exit file once more.
3. jobs.ts: a job with no exit code that nobody stopped (`lost`) is "ended, result unknown": its own notice words
   (not "couldn't finish"), info level, and plain words to the AI. The inbox (web) says the same.
4. Unit test: the placeholder race (a person with no skills folder; the job ends; the poll) and the rowStatus window.

## Decisions

None.

## Risks

runner.ts and tool.ts are being edited by another session: the runner.ts diff stays a few lines in stopRow and
rowStatus; tool.ts is not touched. Six app languages for the new words.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/dev-env-*.test.ts`, web unit test of the inbox row.

## Result

Built as planned. runner.ts: stopRow ends an already-ended run with its own code; rowStatus reads the exit file
again. jobs.ts: "ended, result unknown" (JOB_UNKNOWN, jobOutcome) for the notice and the AI; the web inbox the same
(six languages). Two unit tests in tests/unit/dev-env-srt.test.ts reproduce both races (the first gave exactly the qa
row: exit_code null, end_reason setting) and pass now. tool.ts not touched.
