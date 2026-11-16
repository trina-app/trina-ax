# One file per design decision (docs/decisions/)

- Date (UTC): 2026-11-16 01:37
- Branch: `docs/decisions-split`
- Status: done
- Where: this repository, `docs/decisions/` and `scripts/decisions.ts`. Why: every PR appended to the end of one
  file, so two open PRs always conflicted (see docs/REPOSITORY-RULES.md)
- Version impact: none (docs and a docs check, nothing that ships)

## Goal

`docs/DECISIONS.md` is one file and every PR adds its section at the end. Two open PRs that both add one conflict on
the same lines, so green PRs go un-mergeable within the hour (more than 180 commits touched the file in one day). New
decisions go into one file each, as changelog notes already do in `changes/<topic>.md`. Then two PRs never touch the
same lines.

## Scope

In:

- `docs/decisions/` with a README (format, modelled on `changes/README.md`). Each new decision is
  `docs/decisions/<YYYYMMDD>-<topic>.md` with a fixed header: title, date, status, supersedes.
- `docs/DECISIONS.md` stays as the archive. Old entries are not moved or rewritten. One note at the top says new
  decisions are in `docs/decisions/` from 2026-11-16 on. A new file may link to an old entry's anchor there.
- `scripts/decisions.ts --check` in `bun run check:docs`, next to the changelog guard and with its mechanism (the PR's
  base read with git; `dev` for the release PR): it fails a PR that adds a section or adds lines to an old section of
  `docs/DECISIONS.md`. Changes to the top note pass; a typo fix in an old entry (same number of lines) passes. It also
  fails on a merge marker, a file in `docs/decisions/` without its header, and a broken local link there.
- Every place that told people or agents to add to `docs/DECISIONS.md`: `CLAUDE.md`, `AGENTS.md`,
  `docs/REPOSITORY-RULES.md`, `docs/AGENTS/README.md` (rule and plan template), `docs/WORKPLAN.md`, the PR template,
  the docs site's agent and layout pages.

Out:

- The docs site does not render `DECISIONS.md` (it only links to it), so there is no list page to extend.
- References in code comments (`docs/DECISIONS.md "<title>"`) stay; the titles are still in the archive.

## Steps

1. Plan (this file).
2. `docs/decisions/README.md` and the top note in `docs/DECISIONS.md`.
3. `scripts/decisions.ts`, `tests/unit/decisions-files.test.ts`, `check:docs`.
4. The instruction files and a `changes/` fragment.

## Risks

- Open PRs that still add a section to `DECISIONS.md` fail `check:docs` after this merges: they move the section into
  a file in `docs/decisions/`. The failure message says how.
- A reworded old entry that grows by a line fails too. That is the price of a simple rule; the message says so.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run check:i18n`, `bun test tests/unit/decisions-files.test.ts
tests/unit/changelog-fragments.test.ts`.

## Result

Built as planned, plus two things found on the way:

- The docs-only CI path (`.github/workflows/ci.yml`) matched Markdown directly under `docs/` only, so a PR that adds
  just a decision file would have run the full CI. It now counts `docs/decisions/` too.
- `docs/DECISIONS.md` is 3.4 MB, past `spawnSync`'s 1 MB default buffer: reading the base failed with no message and
  the check would only have warned. The shared base reader (`baseFile` in `scripts/changelog.ts`) now has a large
  buffer, with a test.

Docs-site rendering skipped: the site has no DECISIONS page. The decision itself is the first file,
`docs/decisions/20261116-decisions-split.md`.
