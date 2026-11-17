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
    `bun scripts/ci/unit-shard.ts --times <logs...>` takes several logs and keeps each file's median. When more than
    a fifth of the files have no time, every shard prints a `::warning::` (never a failure: a failing check would
    hold every queued entry, the refresh PR included).
  - 6 unit shards, not 5: ~427 s of tests each (5 would be ~512 s, 7 ~366 s). 7 would cut ~1 more minute but costs a
    job per entry; with 4 entries at once the runners are the limit, so each job's ~1 min setup counts.
  - The extra shard is paid for: on a queued entry (`merge_group`) the phone app typecheck runs as the last steps of
    "typecheck, docs, native, relay" (the same install script and typecheck; ~30 s on a job that is not the longest)
    and the "Mobile app typecheck" job is skipped. It stays advisory there as before (`continue-on-error`: dev does
    not require it). Everywhere else the job runs under its own name, which main's ruleset requires.
  - The relay suite (~2 min with Node's setup) moved from "fast fuzz, web, relay" (now "fast fuzz, web") to the end
    of "typecheck, docs, native", renamed "typecheck, docs, native, relay"; full mode only (a pull request's quick
    run stays quick). npm's download cache there only on a queued entry, where the phone app is installed. That job
    ended ~4 min before the unit shards and now ~1.5 min before; "fast fuzz, web" ends ~3 min before them, the room
    for the advisory web e2e guard (~3.3 min, merge-group only) that fix/web-e2e-drift adds to it next.
  - The unit shards and "fast fuzz, web" restore the native programs (`actions/cache/restore`), keyed on
    `hashFiles('native/**')` and the Go version (the build is reproducible: same key, same bytes). A hit must hold
    all 28 programs, otherwise the job builds them as before. Only a `push` run saves (`actions/cache/save`): main's
    pushes, whose caches every queued entry can read. A queued entry never saves: its ref is read by nothing else,
    and the repository's caches are at the 10 GB limit. native/ changes often on dev, so a queued entry hits only
    when native/ is the same as on main's last push. "typecheck, docs, native, relay" still builds them and runs
    `go vet` / `go test` on every run.
- **Refresh the times** when the warning shows or the shards drift apart by more than a minute:
  1. Pick two to four recent green merge-group runs:
     `gh run list -R trina-app/trina-ax --workflow ci.yml --event merge_group -L 10 --json databaseId,conclusion`.
  2. Download each unit shard's log with timestamps. `gh run view --log` does not parse (no timestamp prefix); use
     the API: for each run, `gh run view <run> -R trina-app/trina-ax --json jobs -q '.jobs[] | select(.name |
     startswith("unit tests")) | .databaseId'`, then for each job id
     `gh api repos/trina-app/trina-ax/actions/jobs/<id>/logs > logs/<run>-<id>.log`.
  3. `bun scripts/ci/unit-shard.ts --times logs/*.log` (writes `scripts/ci/unit-times.json`), check
     `bun scripts/ci/unit-shard.ts --plan 6`, and open a PR with the file.
- **Not changed:** the required check's name and its `needs`, the merge_queue rule, `MERGE_QUEUE`, the macOS / Windows /
  Desktop jobs, the Linux jobs on the push to dev, and which tests run (every file is still in exactly one shard).
  "fast fuzz, web, relay" never waited for typecheck (all build/test jobs need only `scope`); its late start was a
  runner wait. The required check's own runner wait (~2.5 min after the last job) is GitHub's queue; with hosted
  runners every job needs one.
- **Measured after** (manual full run 44059434907, native cache hit): unit shards 9.4, 8.2, 7.7, 7.8, 10.0, 8.0 min
  (tests 383–546 s; the two slow ones ran on slower runners, every file ~1.2–1.3x its median); "typecheck, docs,
  native, relay" 6.5 min; "fast fuzz, web" 5.7 min.
- **Expected in the queue:** still 10 jobs per entry. Most entries miss the native cache (native/ differs from main),
  so the worst shard is ~10.8 min (10.0 + ~0.8 min native build) and a typical one ~8.5–9 min, instead of 12.7.
  "fast fuzz, web" ~6.4 min on a miss, ~9.7 with the e2e guard: about level with the worst shard.
- **Version impact:** none (CI only).
