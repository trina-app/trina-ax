# One file per design decision

- Date: 2026-11-16
- Status: accepted
- Supersedes: none; extends [Docs-only pull requests run only the doc checks](../DECISIONS.md#docs-only-pull-requests-run-only-the-doc-checks-cidocs-only-fast-2026-11-13-product-owner)
- Branch: docs/decisions-split (the owner, 2026-11-16)

- **Why:** every pull request added its section at the end of `docs/DECISIONS.md`. Two open PRs that both added one
  conflicted on the same lines, so green PRs went un-mergeable within the hour; more than 180 commits touched the file
  in one day.
- **Rule:** a new decision is a new file `docs/decisions/<YYYYMMDD>-<topic>.md` with a fixed header (title, date,
  status, supersedes; [README](README.md)), the way changelog notes are files in `changes/`. `docs/DECISIONS.md` stays
  as the archive of everything decided before; its entries are not moved or rewritten, and a new file links to an old
  entry by its anchor.
- **Check:** `bun run decisions:check` (in `bun run check:docs`, so CI) fails a PR that adds a section or lines to
  `docs/DECISIONS.md` below its top note, compared with the PR's base the way the changelog guard does (the release PR
  with dev). A typo fix that keeps the number of lines passes. It also fails on a file here without its header and on
  merge markers; the onboarding docs check checks the links and anchors in these files.
- **Docs-only fast path:** `.github/workflows/ci.yml` counts Markdown files in `docs/decisions/` as docs, like Markdown
  directly under `docs/` and `changes/`, so a PR that only adds a decision still runs only the doc checks.
- **Left as is:** references in code and docs to `docs/DECISIONS.md "<title>"` stay; those titles are in the archive.
  The docs site has no page for the decisions, so there is no list to extend there.
- Tests: `tests/unit/decisions-files.test.ts`. Version impact: **none**.
