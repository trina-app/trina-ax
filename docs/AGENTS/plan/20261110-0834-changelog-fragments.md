# Changelog entries as one file per change (changelog.d/)

- Date (UTC): 2026-11-10 08:34
- Branch: `chore/changelog-fragments`
- Status: done
- Where: trina-ax repository process: `changelog.d/`, `CHANGELOG.md`, `scripts/`, contributor and release docs.
  Why: the merge conflicts come from this repository's own CHANGELOG.md; no product code changes
  (docs/REPOSITORY-RULES.md).
- Version impact: none. Repository process, scripts and docs only; nothing a team installs changes.

## Goal

Every PR adds its line at the top of `## Unreleased` in CHANGELOG.md. When one PR merges, every other open PR
conflicts on that line, and each conflict costs a full CI run (about 25 minutes). A scripted conflict resolution also
left `||||||| <sha>` lines in dev (#314; one more, `||||||| 878a597a`, is still there).

After this, each PR adds its own file `changelog.d/<slug>.md`. Two PRs never touch the same file, so the changelog
stops causing conflicts. A release folds the files into CHANGELOG.md with one command.

## Scope

In:
- `changelog.d/README.md`: the format, in short. Each other `changelog.d/*.md` file is one entry, written exactly as
  it would have been under `## Unreleased` (a `- ` bullet, or a paragraph such as an upgrade note).
- `## Unreleased` stays in CHANGELOG.md with one note that points to `changelog.d/` (option (a) of the request).
  Today's 49 Unreleased entries move into fragment files, so unreleased changes are in one place. The stray
  `||||||| 878a597a` line goes away with them.
- `scripts/changelog-collect.ts` and `bun run changelog:collect [<version>] [--date YYYY-MM-DD] [--dry-run]`: writes
  `## <version> — <date>` right under `## Unreleased` and its note, puts the fragments under it and deletes them. The
  version defaults to `server/package.json`'s, the date to today. Paragraph fragments come first (an upgrade note
  sits above the list, as in earlier releases), then the bullets. Within each group the order is the file name.
- `scripts/check-changelog.ts`, run by `bun run check:docs` (CI's docs step): fails, with a message that says where the
  entry goes, when a fragment is empty, not UTF-8 text, has a heading, an unclosed code block or a merge-conflict
  marker, when a file in `changelog.d/` is not a `<slug>.md`, and when `## Unreleased` holds anything but its note.
- Docs: REPOSITORY-RULES, AGENTS.md, CLAUDE.md, docs/AGENTS/README.md, CONTRIBUTING.md, the site's contributing and
  coding-agents pages, the PR template, and the release step in docs/RELEASE-CI.md and .github/RELEASE_TEMPLATE.md.

Out:
- No product code changes. Nothing in the server, web, desktop or the update feed reads CHANGELOG.md (checked
  `shared/src/api/system.ts`, `shared/src/cloud-protocol/release.ts`, `web/src/components/ReleaseNotes.tsx`: release
  notes come from the tag message, not from this file).
- No release is cut.

## Choices

- **(a) over (b).** One place for unreleased changes: a reader looks in `changelog.d/`, the release tool reads only
  `changelog.d/`, and the check can be a plain rule ("nothing under Unreleased but the note") with no git history.
- **File name order, not first commit date.** It needs no git history (CI checks out shallow; tests run without git),
  the same files always give the same section, and the order is visible in `ls`. The release owner can still move a
  headline entry to the top by hand in the release commit, as release commits already edit the section.
- **The check has no base branch.** It reads the files as they are, so it works on a PR, on a push and locally.
- **Entries under Unreleased are not lost.** dev merges without waiting for CI, so a PR may still land a line under
  `## Unreleased`. `changelog:collect` carries such lines into the release section (and says so) instead of dropping
  them.

## Steps

1. This plan (first commit).
2. `scripts/changelog-collect.ts`, `scripts/check-changelog.ts`, the package scripts and their unit tests.
3. Move the 49 Unreleased entries into fragment files; CHANGELOG.md keeps the heading and the note.
4. Docs and the PR template; this PR's own entry as a fragment.
5. typecheck, check:docs, check:i18n and the new unit tests.

## Risks

- Open PRs that still add a line under `## Unreleased` (#295, #310, #312, `feat/always-show-who-sees`) conflict once
  more when they merge dev, and then fail check:docs until the line moves into `changelog.d/<slug>.md`. The message
  says so. The PR body gives the one-line migration.
- The release session must run `bun run changelog:collect` in the release commit; otherwise the new version's section
  is empty. The PR body and docs/RELEASE-CI.md say so.
- No migration, permission, i18n, phone or desktop change.

## Tests

- Unit: `tests/unit/changelog-fragments.test.ts`: collect order (paragraphs first, then file name), fragments
  deleted, README kept, Unreleased heading and note kept, an existing version refused; check: an empty fragment fails,
  a new Unreleased line fails, a good fragment passes, and the repository itself passes.
- `bun run typecheck`, `bun run check:docs`, `bun run check:i18n`.

## Result

Built as planned:
- `scripts/changelog-collect.ts` (`bun run changelog:collect`) and `scripts/check-changelog.ts` (`bun run
  check:changelog`, now the last step of `bun run check:docs`). The rules live in the collect script, so the release
  refuses the same fragments the check refuses.
- `changelog.d/README.md` and 49 fragment files, one per entry that was under `## Unreleased` (same text, byte for
  byte); CHANGELOG.md keeps `## Unreleased` with one note. The stray `||||||| 878a597a` line is gone. This change's
  own entry is `changelog.d/changelog-fragments.md`.
- Docs: REPOSITORY-RULES, AGENTS.md, CLAUDE.md, docs/AGENTS/README.md, CONTRIBUTING.md, docs/site/develop/
  contributing.md, docs/site/agents/coding-agents.md, the PR template; the release step in docs/RELEASE-CI.md section
  1 and .github/RELEASE_TEMPLATE.md.
- Added after the first draft: hidden files in `changelog.d/` (`.DS_Store`, `.gitkeep`) are not entries; collect says
  "bump the version first" when server/package.json still has the released version. A trial merge of an open PR
  (#295) that kept both sides put all 49 moved lines back under `## Unreleased`: the check now reports such copies
  of fragment lines in one message (and each new line on its own), and collect drops the copies, so no entry shows
  twice in a release.
- Tests: `tests/unit/changelog-fragments.test.ts` (9 tests). PR: see the branch's pull request into `dev`.
