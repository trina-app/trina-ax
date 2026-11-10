# Changelog check in CI: no new lines under "## Unreleased"

- Date (UTC): 2026-11-10 14:22
- Branch: `chore/changelog-check-in-ci`
- Status: in progress
- Where: trina-ax repository process: `scripts/changelog.ts`, `package.json`, contributor docs. Why: it finishes the
  changelog fragments of #322 (`changes/<topic>.md`); no product code changes (docs/REPOSITORY-RULES.md).
- Version impact: none. Repository process, a script and docs; nothing a team installs changes.

## Goal

#322 moved new changelog notes to `changes/<topic>.md`, but nothing stops a PR from still adding a line under
"## Unreleased" in CHANGELOG.md, and `bun run changelog:check` does not run in CI. PRs merged after #322 still added
lines there, so open PRs keep conflicting on the same lines. After this, CI fails such a PR with a message that says
where the note goes.

## Scope

In:
- `check:docs` runs `bun run changelog:check` at its end, so CI's "Onboarding documentation contracts" step runs it.
- `changelog:check` compares "## Unreleased" with the PR's base. In GitHub Actions on a pull request
  (`GITHUB_BASE_REF` set) it fetches the base branch (`git fetch --depth=1 origin <base>`) and reads its CHANGELOG.md.
  It fails when the section has more notes than the base's and lines that are nowhere in the base's CHANGELOG.md:
  "put your entry in changes/<topic>.md". A fix to a note that is already there keeps the count and passes. Lines that
  a release moved out of the section in the meantime are still in the base's file, so they are not counted as new.
- On a push (to dev, main, a tag) or locally, there is no base: that part is skipped quietly. `CHANGELOG_BASE=<git ref>`
  runs it locally against a ref (no fetch), for a check before pushing.
- If the base cannot be read in CI (fetch fails), the comparison is skipped with a `::warning::` line, not a failure.
- Docs: REPOSITORY-RULES, CONTRIBUTING, docs/site/develop/contributing.md, docs/site/agents/coding-agents.md, the PR
  template, docs/AGENTS/README.md, and changes/README.md (what the check does), in #322's wording.
- This PR's own entry: `changes/changelog-check-in-ci.md`.

Out:
- The notes already under "## Unreleased" stay there (#322's choice). The release steps (`changelog:fold`) stay as they
  are.

## Steps

1. This plan (first commit).
2. `scripts/changelog.ts`: `newUnreleasedLines(base, head)`, `baseChangelog(root, env)`, wired into `--check`; unit
   tests.
3. `package.json` `check:docs`; docs; `changes/changelog-check-in-ci.md`.
4. typecheck, check:docs, the changelog tests.

## Risks

- Open PRs that still add a line under "## Unreleased" fail check:docs once this lands. The fix is one move: put the
  line in `changes/<topic>.md`. The message says so.
- The fetch needs network in the static job; it reads the public repository without credentials
  (`persist-credentials: false` stays). A failed fetch only warns.
- `GITHUB_BASE_REF` is passed to git as one argument (no shell) and must look like a branch name.

## Tests

- Unit (`tests/unit/changelog-fragments.test.ts`): a new line fails; a fixed note passes; a note moved to changes/
  passes; lines a release moved out are not new; no base means no check; the base is read from `CHANGELOG_BASE` and,
  with `GITHUB_BASE_REF`, fetched from `origin` (temporary git repositories).
- `bun run typecheck`, `bun run check:docs`, `bun run check:i18n`.

## Result

Filled in at the end.
