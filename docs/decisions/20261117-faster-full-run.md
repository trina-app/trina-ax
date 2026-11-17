# The full CI run uses 6 unit shards, fresh unit times and cached native programs, still 10 jobs per queued entry

- Date: 2026-11-17
- Status: accepted
- Supersedes: the shard count of [CI unit tests in shards](../DECISIONS.md#ci-unit-tests-in-shards-cishard-unit-tests-2026-11-09) (5 → 6)
- Branch: ci/faster-full-run (QA TC-4675)

- **Ask:** make the full run in dev's merge queue ([20261117-merge-queue.md](20261117-merge-queue.md)) shorter
  without spending money (GitHub Free, public repository: standard runners cost nothing, at most ~20 jobs at once)
  and without more jobs per queued entry: since 2026-11-17 09:45Z the queue builds 4 entries at once, so 4 entries
  and the pull requests' quick runs share the 20 runners.
- **Measured before** (merge-group run of PR #1205, 2026-11-17 08:26Z, 23 min): "typecheck, docs, native" 4.4 min;
  unit shards 9.5–12.7 min (the longest, 2/5, set the run); "fast fuzz, web, relay" 8.2 min; the rest was waiting for
  runners. Each unit shard spent ~1.7 min on setup (apt tools 20–40 s, the native build 45–50 s) and the rest in
  `bun test`. A queued entry ran 10 jobs: what changed, the phone app, typecheck/docs/native, 5 unit shards,
  fuzz/web/relay, the required check.
- **Why the shards were uneven:** `scripts/ci/unit-times.json` knew 499 of the 828 test files. The other 340 counted
  as the median, so the planned ~408 s per shard came out at 500–650 s.
- **Rule:**
  - `unit-times.json` is the median per file of 15 shard logs (four merge-group runs of 2026-11-17).
    `bun scripts/ci/unit-shard.ts --times <logs...>` now takes several logs and keeps each file's median.
    `tests/unit/ci-unit-shard.test.ts` fails when more than a fifth of the files have no time: refresh it then.
  - 6 unit shards, not 5: ~427 s of tests each (5 would be ~512 s, 7 ~366 s). 7 would cut ~1 more minute but costs a
    job per entry; with 4 entries at once the runners are the limit, so each job's ~1 min setup counts.
  - The extra shard is paid for: on a queued entry (`merge_group`) the phone app typecheck runs as the last steps of
    "typecheck, docs, native" (the same install script and typecheck; ~30 s on a job that is not the longest) and
    the "Mobile app typecheck" job is skipped. It stays advisory there as before (`continue-on-error`: dev does not
    require it). Everywhere else the job runs under its own name, which main's ruleset requires.
  - The unit shards and "fast fuzz, web, relay" restore the native programs from actions/cache, keyed on
    `hashFiles('native/**')` and the Go version (the build is reproducible: same key, same bytes). A hit must hold
    all 28 programs, otherwise the job builds them as before. "typecheck, docs, native" still builds them and runs
    `go vet` / `go test` on every run. A merge-group run reads the caches of main (the default branch) and its own;
    when native/ changed on dev since main, the shards build as before.
- **Not changed:** the required check's name and its `needs`, the merge_queue rule, `MERGE_QUEUE`, the macOS / Windows /
  Desktop jobs, the Linux jobs on the push to dev, and which tests run (every file is still in exactly one shard).
  "fast fuzz, web, relay" never waited for typecheck (all build/test jobs need only `scope`); its late start was a
  runner wait. The required check's own runner wait (~2.5 min after the last job) is GitHub's queue; with hosted
  runners every job needs one.
- **Expected:** a queued entry still runs 10 jobs. The longest job ~8 min instead of ~12.7 (shard ~1 min setup with
  a native hit + ~7.1 min tests; fuzz/web/relay ~7.3 min), about the same runner minutes per entry (the native
  cache saves ~45 s in six jobs, the extra shard adds one setup).
- **Version impact:** none (CI only).
