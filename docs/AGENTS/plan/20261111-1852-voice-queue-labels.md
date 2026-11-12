# Voice input says when it waits; job step labels are never dropped

- Date (UTC): 2026-11-11 18:52
- Branch: `fix/voice-queue-labels`
- Status: done
- Where: `server/src/jobs/service.ts`, `web/src/lib/`, `web/src/store/jobs.ts`. Why: the job service and the composer are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, two UX bug fixes with no new setting or API

## Goal

QA 11-12, TC-154 follow-ups:

- F1. A voice recording whose job only waits for the one transcription slot (another voice input is transcribed
  first) shows "Transcribing…". The server sends nothing for a queued job, and the composer falls back to
  `voice.transcribing`.
- F2. The 500 ms progress throttle drops every update that comes too soon after the previous one and never sends the
  latest later. A backup step under 500 ms swallowed the update job's "download" step, so a stalled download showed
  "Backing up the database" (0.2) for two minutes.

## Scope

In:
- Job service: a job that starts running publishes `job.progress` (no progress, no label) at once. A new step label is
  never held back; a same-step update that is held back goes out when the 500 ms are over (a trailing timer, cleared
  when the job settles).
- Web: `voice.waiting` ("Waiting for another voice input to finish…", five locales) while the job is known to be
  queued. `waitForJob` looks at the job once right away and records a waiting / running job's status in the jobs store
  (never back from running to queued, never over the socket's label).
- Mock server: transcription jobs say when they start; `/__test/transcribe-progress` takes `queuedMs`.

Out: `server/src/system/job-runner.ts` (the fallback job service, used only when component C's service is not
installed); a "waiting" line for queued backups and exports in Admin (they keep "Working…").

## Steps

1. Plan (this commit).
2. `tests/unit/p1-job-steps.test.ts`: no event for a queued job, a start event when it runs; a new label within 500 ms
   goes out; the last held-back update goes out after the throttle; nothing written after the job settled. Fails
   before the fix. `c-jobs.test.ts`'s throttle case keeps one label (a new label is not throttled now).
3. service.ts: start event, label-aware throttle with a trailing write.
4. Web: `jobWaiting`, `voice.waiting`, the immediate first poll and `seen` in the jobs store; unit tests in
   `voice.test.ts`, `lib.test.ts`; `voice.spec.ts` e2e on the mock (fails before the fix).
5. Hands-on: the QA stall server (copied) with the real dev server (F1 over WebSocket) and the update route harness
   (F2).

## Risks

- A job whose label changes on every call would not be throttled. Checked every `h.progress` caller: labels are
  constant per step (restore's `archive i/n` changes once per archive).
- One more event per job in the replay buffer (the start event).
- No migration, no API change, five locales.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the job tests (`c-jobs`, `p1-job-*`, `g-update-auto`,
`g-routes`, `g-queue-retention`, `c-uploads`, `contracts`), the web unit tests, the voice and admin e2e specs.

## Result

Done. F1 and F2 reproduced with the QA stall server before the fix and gone after it; unit, e2e and the area tests
pass. Independent review: no must-fix; its two should-fixes (a job not heard of yet showed "waiting"; an older REST
answer could put a started job back to waiting) are fixed in this branch.
