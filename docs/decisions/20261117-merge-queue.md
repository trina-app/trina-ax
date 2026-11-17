# dev takes pull requests through a merge queue; a pull request runs only the quick checks

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: ci/merge-queue (the owner approved the merge queue, QA TC-4555)

- **Ask:** every pull request ran ~14 CI jobs (five unit shards, "fast fuzz, web, relay", typecheck, the phone app,
  and the path-filtered macOS / Windows jobs). Many sessions open pull requests at once, the GitHub Free plan's 20
  concurrent jobs fill up and jobs wait 30+ minutes; each merge to dev also made waiting pull requests merge dev and
  run everything again. Run the full suite once per queued pull request on top of the latest dev instead.
- **Rule:** the dev ruleset ("dev: CI must pass", 26852328) gets a `merge_queue` rule: merge commits (`MERGE`, as
  today: the release PR carries a merge of main), `ALLGREEN`, at most 5 entries built at once, groups of 1 to 8,
  60 minutes for the checks. `.github/workflows/ci.yml` runs on `merge_group` too, and its `scope` job ("what changed")
  picks a mode:

  | Event | Mode | Jobs that run |
  |---|---|---|
  | pull request to dev, repository variable `MERGE_QUEUE` = `on` | quick | what changed, typecheck/docs/native, Mobile app typecheck, the required check |
  | pull request to dev with the label `full-ci`, or while `MERGE_QUEUE` is not `on` | full | every job below except the Linux ones |
  | pull request to main | full | as above (main's ruleset requires the check; it is not queued) |
  | queued entry (`merge_group`) | full | what changed, typecheck/docs/native, unit 1–5, fast fuzz/web/relay, Mobile app typecheck, the required check |
  | push to dev by `github-merge-queue[bot]` | tested | what changed, Mobile app typecheck, the required check, the six Linux jobs |
  | any other push to dev or main, a manual run, release.yml / msstore.yml calling CI | full | everything, Linux jobs included |

  A docs-only change (Markdown directly in `docs/`, `docs/decisions/`, `changes/`) runs only the doc checks, on a pull
  request and on a queued entry (the entry's diff against the queue's base). The required check "typecheck, native,
  unit, fast fuzz, web, relay" always runs (`if: always()`) and passes only when the jobs of its mode passed: in quick
  mode the unit and fuzz/web/relay jobs must be *skipped*, in full mode they must have *succeeded* (a skipped one fails).
- **Why:** GitHub only lets a pull request into the queue when its required checks pass on the pull request, then runs
  the required checks again on the queued entry (`merge_group`: the pull request merged on top of dev and of the
  entries ahead of it) and lands it only when they pass there. A required check that never reports on `merge_group`
  holds the entry until the time-out and removes it ("the merge will fail as the required status check will not be
  reported", GitHub docs, events-that-trigger-workflows#merge_group). A job skipped by a job-level `if:` reports
  success (GitHub docs, troubleshooting required status checks); a workflow skipped by a path filter stays pending,
  which is why the required check has no path filter and decides inside the run. So a pull request needs ~4 short jobs
  (5–8 minutes), the heavy suite runs once per pull request on the final code, and nobody merges dev to rerun CI.
- **The push after the queue (mode tested):** the queue fast-forwards dev to the entry's commit it tested, so the pushed
  SHA is the SHA that passed (seen on microsoft/vscode and bevyengine/bevy: the `merge_group` run's head SHA is the
  commit on the default branch; GitHub's docs say only that the temporary branch "will be merged in to the target
  branch"). The push's actor is then `github-merge-queue[bot]`, and only that push skips typecheck, the unit shards and
  fuzz/web/relay. A push by anyone else (an admin merge past the queue, `gh pr merge --admin`) runs everything. The
  Linux attack suite, release bundle and install test (six jobs, not required) stay on the push to dev, as before; they
  do not run on `merge_group`, so a queued entry never waits on them.
- **Not in the queue:** desktop.yml (Desktop e2e on macOS, Mac dmg, Windows installer), mac-whisper.yml and msstore.yml
  have no `merge_group` trigger. They are not required on dev and hosted macOS runners are short (macos-15 jobs went
  unstarted on 2026-11-16), so a queued entry must never wait on them. They stay advisory: path-filtered on the pull
  request, and Desktop e2e on every push to dev. dev-build.yml, feature-map.yml, release.yml, team-image.yml and
  feed.yml are unchanged (they run on the push to dev, on tags or by hand). main's ruleset is unchanged: a pull request
  to main always runs in full mode.
- **Queue settings** (`merge_queue` rule parameters): `merge_method: MERGE`, `grouping_strategy: ALLGREEN` (every
  entry's own commit must pass, not only the group's last), `max_entries_to_build: 5`, `max_entries_to_merge: 8`,
  `min_entries_to_merge: 1`, `min_entries_to_merge_wait_minutes: 5`, `check_response_timeout_minutes: 60`. Each entry
  is one full run of ~10 jobs, so five entries building at once ask for ~50 jobs against the org's 20; time spent
  waiting for a runner counts toward the 60 minutes. If entries time out, lower `max_entries_to_build` to 2 first.
- **How a session merges:** after the independent review and the quick checks,
  `gh pr merge <n> --merge --match-head-commit <sha>`. With a queue gh does not merge: it calls
  `enablePullRequestAutoMerge` with the expected head (so `--match-head-commit` is honoured: a newer push refuses), and
  GitHub adds the pull request to the queue once its checks pass ("will be added to the merge queue for dev when
  ready"). `--merge` only prints that the queue sets the method; `--auto` changes nothing; `--delete-branch` is refused
  with a queue; `--admin` skips the queue and must not be used.
- **Hotfix or risky PR (jump the queue):** a repository admin adds it at the front: in the pull request's merge box,
  or `gh api graphql -f query='mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,jump:true,expectedHeadOid:$sha}){mergeQueueEntry{position}}}' -f id=<PR node id> -f sha=<head sha>`.
  Jumping rebuilds every entry already building, so it is for hotfixes and release PRs only. A risky pull request can
  also get the label `full-ci` to run the whole suite before it enters the queue.
- **Removed from the queue:** GitHub removes an entry whose required check fails, times out, or that conflicts with
  dev. Open the failing `merge_group` run (Actions, event "merge_group", branch `gh-readonly-queue/dev/pr-<n>-…`),
  fix the cause on the branch and push; the pull request's quick checks run and the session queues it again with the
  same `gh pr merge` command. Do not merge dev into the branch only to rerun CI; merge dev only to fix a conflict.
  A failure caused by an entry ahead (the group was rebuilt) needs no change: queue it again.
- **Why a variable:** quick mode is safe only while the queue exists: without it a pull request would land on dev
  after the quick checks alone. So quick mode also needs the repository variable `MERGE_QUEUE` = `on`, which is set
  after the rule and removed before it. Merging this change alone changes nothing for a pull request (full mode, as
  today) except that ci.yml also answers `merge_group`.
- **Switch-on order:** (1) merge this change to dev (pull requests still run in full); (2) apply the ruleset body with
  the `merge_queue` rule (`gh api -X PUT repos/trina-app/trina-ax/rulesets/26852328 --input merge-queue-ruleset.json`);
  (3) queue one small pull request and watch its `merge_group` run report "typecheck, native, unit, fast fuzz, web,
  relay" and land, and the push run after it show mode `tested`; (4) `gh variable set MERGE_QUEUE --body on`. The
  reverse of (1)/(2) would queue entries that no workflow tests.
- **Turning it off:** (1) `gh variable delete MERGE_QUEUE` (pull requests run the full suite again);
  (2) apply the rollback body (today's ruleset, without the `merge_queue` rule) with the same `gh api -X PUT`. Pull
  requests then merge as before with the same required check. Entries still in the queue are dropped when the rule
  goes; queue nothing during the switch. The `merge_group` trigger can stay in ci.yml: nothing sends it without a
  queue.
- **Tests:** `tests/unit/ci-merge-queue.test.ts` (the required check runs on `merge_group`, `needs` only the scope /
  docs / build and test jobs, the mode of each event, the check's verdict for each mode, no macOS / Windows workflow
  on `merge_group`, the Linux jobs off the queue). `actionlint` on ci.yml and desktop.yml.
- **Version impact:** none (CI only).
