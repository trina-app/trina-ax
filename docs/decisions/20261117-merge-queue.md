# dev takes pull requests through a merge queue; a pull request runs only the quick checks

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: ci/merge-queue (the owner approved the merge queue, QA TC-4555)

- **Ask:** every pull request ran ~14 CI jobs (five unit shards, "fast fuzz, web, relay", typecheck, the phone app,
  and the path-filtered macOS / Windows jobs). Many sessions open pull requests at once, the GitHub Free plan's 20
  concurrent jobs fill up and jobs wait 30+ minutes; each merge to dev also made waiting pull requests merge dev and
  run everything again.
- **Rule:** the dev ruleset ("dev: CI must pass", 26852328) gets a `merge_queue` rule (settings below).
  `.github/workflows/ci.yml` runs on `merge_group` too, and its `scope` job ("what changed") picks a mode:

  | Event | Mode | Jobs that run |
  |---|---|---|
  | pull request to dev, repository variable `MERGE_QUEUE` = `on` | quick | what changed, typecheck/docs/native, Mobile app typecheck, the required check |
  | pull request to dev while `MERGE_QUEUE` is not `on` | full | every job below except the Linux ones |
  | pull request to main | full | as above (main's ruleset requires the check; it is not queued) |
  | queued entry (`merge_group`) | full | what changed, typecheck/docs/native, unit 1–5, fast fuzz/web/relay, Mobile app typecheck, the required check |
  | push to dev by `github-merge-queue[bot]` | tested | what changed, Mobile app typecheck, the required check, the six Linux jobs |
  | `gh workflow run ci.yml --ref <branch>` (manual) | full | every job, Linux jobs included |
  | any other push to dev or main, release.yml / msstore.yml calling CI | full | every job, Linux jobs included |

  The required check "typecheck, native, unit, fast fuzz, web, relay" always runs (`if: always()`) and passes only
  when the jobs of its mode passed: in quick mode the unit and fuzz/web/relay jobs must be *skipped*, in full mode they
  must have *succeeded* (a skipped one fails).
- **Docs-only shortcut:** a change of only Markdown directly in `docs/`, `docs/decisions/` or `changes/` runs only
  the doc checks. On a pull request the diff is the PR's merge commit against its base. On a queued entry it is the
  entry's commit against `merge_group.base_sha`, which is the entry's **parent**: the entry ahead of it in the queue
  (dev itself only for the first entry). So the shortcut looks at what this one pull request adds, not at everything
  queued since dev.
- **Grouping MUST stay `ALLGREEN`.** With `ALLGREEN` every entry's own commit has to pass its required check, so an
  entry that ran only the doc checks still lands only after the code entries ahead of it passed the full suite. With
  `HEADGREEN` only the last entry of a group has to pass: a failing code PR followed by a docs-only PR could then land
  on the doc checks alone. Changing the grouping means first removing the docs-only shortcut on `merge_group`.
  `tests/unit/ci-merge-queue.test.ts` checks the settings block below.
- **Why:** GitHub only lets a pull request into the queue when its required checks pass on the pull request, then runs
  the required checks again on the queued entry (`merge_group`: the pull request merged on top of dev and of the
  entries ahead of it) and lands it only when they pass there. A required check that never reports on `merge_group`
  holds the entry until the time-out and removes it ("the merge will fail as the required status check will not be
  reported", GitHub docs, events-that-trigger-workflows#merge_group). A job skipped by a job-level `if:` reports
  success (GitHub docs, troubleshooting required status checks); a workflow skipped by a path filter stays pending,
  which is why the required check has no path filter and decides inside the run.
- **What it saves, plainly:** the full suite still runs **once per queued pull request, not once per group**: the queue
  builds a commit per entry and each one runs the ~10 jobs. The saving is (1) no full run on every push to a pull
  request (a PR runs ~4 short jobs, 5–8 minutes) and (2) no "merge dev and rerun everything" loops. Sessions should
  still batch small related changes into one pull request before queueing it.
- **Queue settings** (the `merge_queue` rule's parameters, exactly as applied):

  ```json
  {
    "merge_method": "MERGE",
    "grouping_strategy": "ALLGREEN",
    "max_entries_to_build": 2,
    "max_entries_to_merge": 5,
    "min_entries_to_merge": 1,
    "min_entries_to_merge_wait_minutes": 5,
    "check_response_timeout_minutes": 60
  }
  ```

  `MERGE`: merge commits as today (the release PR carries a merge of main). `max_entries_to_build: 2`: two entries of
  ~10 jobs fit in the org's 20 concurrent jobs. `max_entries_to_merge: 5`: up to five passed entries land in one push.
  `min_entries_to_merge: 1`: the queue never waits to fill a group, so `min_entries_to_merge_wait_minutes` has no
  effect (the API requires a value). `check_response_timeout_minutes: 60`.
- **The push after the queue (mode tested):** the queue fast-forwards dev to the entry's commit it tested, so the pushed
  SHA is the SHA that passed (seen on microsoft/vscode and bevyengine/bevy, which squash: the `merge_group` run's head
  SHA is the commit on the default branch; GitHub's docs say only that the temporary branch "will be merged in to the
  target branch"; the switch-on checklist confirms it for `MERGE`). The push's actor is then `github-merge-queue[bot]`,
  and only that push skips typecheck, the unit shards and fuzz/web/relay. A push by anyone else runs everything. The
  Linux attack suite, release bundle and install test (six jobs, not required) stay on the push to dev, as before; they
  do not run on `merge_group`, so a queued entry never waits on them.
- **Not in the queue:** desktop.yml (Desktop e2e on macOS, Mac dmg, Windows installer), mac-whisper.yml and msstore.yml
  have no `merge_group` trigger. They are not required on dev and hosted macOS runners are short (macos-15 jobs went
  unstarted on 2026-11-16), so a queued entry must never wait on them. They stay advisory: path-filtered on the pull
  request, and Desktop e2e on every push to dev. dev-build.yml, feature-map.yml, release.yml, team-image.yml and
  feed.yml are unchanged (they run on the push to dev, on tags or by hand). main's ruleset is unchanged: a pull request
  to main always runs in full mode.
- **Desktop PRs:** the Desktop workflow's pull request jobs (Desktop e2e, Mac dmg check, Windows installer) still run on
  pull requests that touch their paths (`desktop/`, `shared/`, and the rest of desktop.yml's `paths`). They are
  advisory and never part of the queue, so the queue lands such a PR without them: look at those three results
  **before** queueing it. When hosted macOS runners are short, run the Mac jobs locally and post the result on the PR
  (Bun 1.3.12, `CI=true`, no signing):

  ```bash
  bun install --frozen-lockfile && bun run build:web && bun run prepare:hwp
  (cd desktop && bun build.ts && bunx playwright test -c e2e/ci.config.ts)
  CSC_IDENTITY_AUTO_DISCOVERY=false bun run --cwd desktop dist:mac && bun scripts/ci/dmg-check.ts desktop/release
  ```
- **How a session merges:** after the independent review and the quick checks,
  `gh pr merge <n> --merge --match-head-commit <sha>`. With a queue gh (2.96, `pkg/cmd/pr/merge`) does not merge: it
  calls `enablePullRequestAutoMerge` with the expected head (so `--match-head-commit` is honoured: a newer push
  refuses), and GitHub adds the pull request to the queue once its checks pass ("will be added to the merge queue for
  dev when ready"). `--merge` only prints that the queue sets the method; `--auto` changes nothing; `--delete-branch`
  is refused with a queue; `--admin` skips the queue and is never used. The repository has `allow_auto_merge: false`;
  whether gh's call still enqueues is item 1 of the switch-on checklist. If it is refused, sessions enqueue directly:

  ```bash
  id=$(gh pr view <n> --json id -q .id)
  gh api graphql -f query='mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){mergeQueueEntry{position state}}}' -f id="$id" -f sha=<head sha>
  ```

- **The full suite on a pull request on demand** (a risky change, before queueing): `gh workflow run ci.yml --ref
  <branch>` (workflow_dispatch, mode full). Its required check lands on the branch's head commit, which is the pull
  request's head. There is no label for this: a label event would cancel and restart the PR's run and flash a red
  required check.
- **Hotfix or release PR (jump the queue):** a repository admin adds it at the front, in the pull request's merge box or:

  ```bash
  id=$(gh pr view <n> --json id -q .id)
  gh api graphql -f query='mutation($id:ID!,$sha:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,jump:true,expectedHeadOid:$sha}){mergeQueueEntry{position state}}}' -f id="$id" -f sha=<head sha>
  ```

  Jumping rebuilds every entry already building, so it is for hotfixes and release PRs only. GitHub's docs do not say
  who may jump; the checklist confirms it with an admin.
- **Removed from the queue:** GitHub removes an entry whose required check fails, times out, or that conflicts with
  dev. Open the failing `merge_group` run (Actions, event "merge_group", branch `gh-readonly-queue/dev/pr-<n>-…`),
  fix the cause on the branch and push; the pull request's quick checks run and the session queues it again with the
  same command. Do not merge dev into the branch only to rerun CI; merge dev only to fix a conflict. A failure caused
  by an entry ahead (the entry was rebuilt) needs no change: queue it again.
- **Known gaps:**
  - An admin can bypass the queue with `gh pr merge --admin` (the ruleset's bypass actor, the admin role in
    `pull_request` mode). The rule for sessions stays: never `--admin`. The push run after such a merge (mode full,
    the actor is not the queue) is the only net, and it runs after the code is on dev.
  - The 60-minute time-out counts time spent waiting for a runner, not only running. An entry that times out is
    removed, and the entries behind it are rebuilt (each runs its ~10 jobs again).
  - A rebuilt entry's earlier run is not cancelled (its ref differs); it keeps its runners until it ends.
  - Whether `vars.MERGE_QUEUE` reaches a pull request from a fork (the contrib fork) is not confirmed in GitHub's
    docs; if not, those pull requests run the full suite (safe, just not faster).
- **Why a variable:** quick mode is safe only while the queue exists: without it a pull request would land on dev
  after the quick checks alone. So quick mode also needs the repository variable `MERGE_QUEUE` = `on`, which is set
  after the rule and removed before it. Merging this change alone changes nothing for a pull request (full mode, as
  today) except that ci.yml also answers `merge_group`.
- **Switch-on order:** (1) merge this change to dev (pull requests still run in full); (2) apply the ruleset body with
  the `merge_queue` rule (`gh api -X PUT repos/trina-app/trina-ax/rulesets/26852328 --input merge-queue-ruleset.json`);
  (3) run the checklist below with `MERGE_QUEUE` still unset; (4) `gh variable set MERGE_QUEUE --body on`. The reverse
  of (1)/(2) would queue entries that no workflow tests.
- **Switch-on checklist** (step 3; small test PRs to dev, nothing else queued):
  1. `gh pr merge <n> --merge --match-head-commit <sha>` puts the PR in the queue while the repository has
     `allow_auto_merge: false` (the PR shows "Queued"; `gh pr view <n> --json isInMergeQueue`). If refused, use the
     `enqueuePullRequest` command above and write the outcome here.
  2. Its `merge_group` run reports "typecheck, native, unit, fast fuzz, web, relay" (mode full) and the PR lands.
  3. The push run on dev after it shows `mode=tested` in "what changed", and its head SHA equals the `merge_group`
     run's head SHA.
  4. A docs-only PR goes through: its entry runs "docs only" and the required check, and lands.
  5. A deliberately failing PR (one failing unit test) queued ahead of a good one: the failing entry is removed with
     the failing check, and the one behind it is rebuilt and lands.
  6. An admin `jump: true` enqueue puts a PR at the front.
- **Turning it off:** (a) `gh variable delete MERGE_QUEUE` **first** (pull requests run the full suite again);
  (b) apply the rollback body (today's ruleset, without the `merge_queue` rule) with the same `gh api -X PUT`;
  (c) re-run CI on every open pull request to dev before anyone merges (`gh workflow run ci.yml --ref <branch>`, or
  close and reopen): a PR that passed in quick mode still carries a green required check on its head SHA and would
  otherwise merge without the unit tests. Entries still in the queue are dropped when the rule goes; queue nothing
  during the switch. The `merge_group` trigger can stay in ci.yml: nothing sends it without a queue.
- **Incident note:** if the ruleset or its merge queue rule is ever disabled, for any reason (a runner outage, a
  release), delete the variable `MERGE_QUEUE` first, then do (c) above.
- **Tests:** `tests/unit/ci-merge-queue.test.ts` (the required check runs on `merge_group`, `needs` only the scope /
  docs / build and test jobs, the mode of each event, the check's verdict for each mode, no label trigger, no macOS /
  Windows workflow on `merge_group`, the Linux jobs off the queue, the settings block above with `ALLGREEN`).
  `actionlint` on ci.yml and desktop.yml.
- **Version impact:** none (CI only).

- **Switched on:** the `merge_queue` rule was applied to the dev ruleset on 2026-11-17 at 05:48 UTC, right after 0.5.12 was published; the workflow change merged as #1193 (1c44220d0). The switch-on checklist above is run with this pull request (docs only) first.
