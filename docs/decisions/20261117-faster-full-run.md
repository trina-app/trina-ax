# The full CI run uses 7 unit shards, fresh unit times and cached native programs

- Date: 2026-11-17
- Status: accepted
- Supersedes: the shard count of [CI unit tests in shards](../DECISIONS.md#ci-unit-tests-in-shards-cishard-unit-tests-2026-11-09) (5 → 7)
- Branch: ci/faster-full-run (QA TC-4675)

- **Ask:** make the full run in dev's merge queue ([20261117-merge-queue.md](20261117-merge-queue.md)) shorter
  without spending money (GitHub Free, public repository: standard runners cost nothing, at most ~20 jobs at once).
- **Measured before** (merge-group run of PR #1205, 2026-11-17 08:26Z, 23 min): "typecheck, docs, native" 4.4 min;
  unit shards 9.5–12.7 min (the longest, 2/5, set the run); "fast fuzz, web, relay" 8.2 min; the rest was waiting for
  runners. Each unit shard spent ~1.7 min on setup (apt tools 20–40 s, the native build 45–50 s) and the rest in
  `bun test`.
- **Why the shards were uneven:** `scripts/ci/unit-times.json` knew 499 of the 828 test files. The other 340 counted
  as the median, so the planned ~408 s per shard came out at 500–650 s.
- **Rule:**
  - `unit-times.json` is the median per file of 15 shard logs (four merge-group runs of 2026-11-17).
    `bun scripts/ci/unit-shard.ts --times <logs...>` now takes several logs and keeps each file's median.
    `tests/unit/ci-unit-shard.test.ts` fails when more than a fifth of the files have no time: refresh it then.
  - 7 unit shards, not 5: ~366 s of tests each (5 would be ~512 s), about as long as "fast fuzz, web, relay"
    (~7 min). 8 would not shorten the run (that job is then the longest) and two queued entries would need 22 jobs.
    A full run now holds 9 long jobs at once (static, 7 shards, fuzz/web/relay) instead of 7; two queued entries
    (`max_entries_to_build: 2`) take 18 of the 20, a pull request's quick run the rest.
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
- **Expected:** the longest job ~7.3 min instead of ~12.7 (shard ~1 min setup + ~6.1 min tests; fuzz/web/relay
  ~7.3 min), a full run ~9 min with free runners instead of ~14 (plus runner waits when the org is busy).
- **Version impact:** none (CI only).
