# Release Mac jobs on a self-hosted office Mac

- Date (UTC): 2026-11-16 19:24
- Branch: `ci/mac-self-hosted-runner`
- Status: done (kit ready, switched off: hosted macOS runners came back for 0.5.11)
- Where: `.github/workflows/`, `scripts/macos/release-runner/`, `docs/RELEASE-CI.md`. Why: GitHub's hosted macOS pools have no runners and the 0.5.10 Mac release jobs keep getting cancelled; the owner asked to use our Mac.
- Version impact: none (CI and host setup only)

## Goal

The release's Mac jobs (office zip, Mac app, whisper-cli) can run on one office Mac, without letting a public repo run
code on a Mac that holds other work and credentials.

## Scope

In: a hidden standard account `_trinaci` with its own quota'd APFS volume, a sandbox and pf rules; a root supervisor
LaunchDaemon that cleans up and starts a fresh one-time (JIT) runner per job as that account, label
`trina-mac-release` only; job-started hook (host-side gate: release.yml at a v* tag of trina-app/trina-ax only, kills
the job's worker on refusal) and job-completed hook; guard steps in the self-hosted
jobs; mac-app.yml (and #1090's mac-whisper.yml) take `RELEASE_MAC_RUNNER` only when release.yml calls them at a tag;
fork PR approval for all outside contributors; setup and removal in docs/RELEASE-CI.md 13.
Out: runner groups (Free plan).

## Steps

1. Workflows: guard step, runs-on of mac-app.yml and mac-whisper.yml.
2. `scripts/macos/release-runner/` setup.sh, remove.sh, supervisor.sh, hooks, runner.sb, pf.anchor, pf-load.sh.
3. Independent security review of host setup and workflow diff; fix findings.
4. Release coordinator's OK on the workflow diff, PR to dev; owner runs setup.sh with sudo.

## Decisions

[docs/decisions/20261116-mac-self-hosted-runner.md](../../decisions/20261116-mac-self-hosted-runner.md)

## Risks

A public repo with a self-hosted runner: untrusted workflows must never start a step there (label without defaults,
host-side hook, guard steps, fork approval, tag ruleset). Shared machine: own account, no staff group, deny ACL,
sandbox, pf, quota volume, no certificates at rest. Disk: 60 GB quota.

## Tests

actionlint on the workflows; the sandbox profile exercised by hand; setup.sh's own PASS/FAIL checks as `_trinaci`;
the first real job is the re-run of the 0.5.10 Mac jobs.

## Result

Ready but off. Nothing is installed on the Mac and no runner is registered; the workflow changes pick the self-hosted
runner only when `RELEASE_MAC_RUNNER=trina-mac-release`. Changed from the plan after three independent security
reviews: a root supervisor with a one-time (JIT) runner per job instead of a long-lived runner with cleanup hooks
(any job could read a long-lived runner's credentials and poison later jobs); the job-started hook also requires the
tagged commit to be on main and kills the job on refusal; /tmp and loopback in any address family are blocked;
checks run in the jobs' own launchd context. Switching on: docs/RELEASE-CI.md 13.
