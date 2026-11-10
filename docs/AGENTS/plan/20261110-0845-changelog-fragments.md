# Changelog fragments: one file per PR, so PRs stop conflicting on CHANGELOG.md

- Date (UTC): 2026-11-10 08:45
- Branch: `chore/changelog-fragments`
- Status: in progress
- Where: trina-ax (public), `changes/`, `scripts/changelog.ts`, rules in `CLAUDE.md`. Why: a repo process change, no product code.
- Version impact: none. No shipped code changes.

## Goal

Every PR adds a bullet at the top of "## Unreleased" in `CHANGELOG.md`. Two open PRs then conflict on the same
lines, and each fix (merge `dev` into the branch) starts all CI jobs again. On the GitHub Free plan the org runs at most
20 jobs at once and one CI run has many jobs, so this adds to the queue. Wrong fixes also leave merge markers in the file
(commit 805cdff7 removed eight `|||||||` lines; one more is on `dev` now).

## Scope

In:
- `changes/`: one Markdown file per PR (`changes/<topic>.md`) with its bullet(s), in the style of Unreleased.
- `scripts/changelog.ts`: print the Unreleased notes with the fragments; `--fold` moves the fragments into
  `CHANGELOG.md` under "## Unreleased" and deletes them (before a release).
- Rule in `CLAUDE.md` and `changes/README.md`; a step in `docs/RELEASE-CI.md`.
- Remove the stray `|||||||` line from `CHANGELOG.md`.

Out: a CI check that requires a fragment in every PR; moving the bullets that are already in Unreleased.

## Steps

1. `changes/README.md` with the rule and an example.
2. `scripts/changelog.ts` (pure functions + CLI) and `tests/unit/changelog-fragments.test.ts`.
3. `package.json` scripts `changelog` and `changelog:fold`.
4. Rules: `CLAUDE.md` (Branches section), `docs/RELEASE-CI.md` (before the tag).
5. Remove the stray merge-marker line.

## Risks

Agents keep the old habit and edit `CHANGELOG.md`: the rule goes into `CLAUDE.md`, which every agent reads. A fold
that is forgotten before a release leaves notes out of `CHANGELOG.md`: the release step says to fold first.

## Tests

`bun test tests/unit/changelog-fragments.test.ts`, `bun run typecheck`.

## Result

