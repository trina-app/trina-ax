# Design decisions

From 2026-11-16 a pull request does not add a section to [`docs/DECISIONS.md`](../DECISIONS.md). It writes each new
decision as one new file here:

```
docs/decisions/<YYYYMMDD>-<topic>.md
```

- `<YYYYMMDD>`: the day the decision is written, UTC (`date -u +%Y%m%d`).
- `<topic>`: the branch name without its prefix (`fix/guest-email-unique` → `20261116-guest-email-unique.md`), in
  lowercase words joined with `-`. Two PRs then never write the same file. A PR with two decisions adds two files
  (`…-guest-email-unique.md`, `…-guest-email-tries.md`).
- `docs/DECISIONS.md` is the archive of everything decided before 2026-11-16. Read it for older decisions; do not add
  to it. Fixing a typo in an old entry is fine.

## Format

The first lines are a fixed header, then the body in the style of the archive (**Ask**, **Rule**, **Why**, what was left
out, tests, version impact):

```markdown
# A guest can't take an e-mail used in the team

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/guest-email-unique (the owner, QA TC-3300)

- **Ask:** ...
- **Rule:** ...
```

- `# <title>`: the decision in one line, as people will quote it (`docs/decisions/20261116-….md "<title>"`).
- `- Date:` the same day as the file name, `YYYY-MM-DD`.
- `- Status:` `accepted`, `superseded` (followed by a link to the file that replaces it) or `dropped`.
- `- Supersedes:` `none`, or links to what this replaces: another file here, or an old entry in the archive by its
  heading's anchor, e.g. [Docs-only pull requests](../DECISIONS.md#docs-only-pull-requests-run-only-the-doc-checks-cidocs-only-fast-2026-11-13-product-owner)
  (`../DECISIONS.md#<anchor>`; copy it from the heading's link on GitHub). Old entries are not edited to point back;
  the newer file is the one that counts.
- Optional lines after these (branch, who asked, QA rows) are free.

When a later decision replaces one of these files, the later PR also changes the old file's `- Status:` line.

Why: every PR added its section at the end of `docs/DECISIONS.md`, so any two open PRs conflicted on the same lines.
Green PRs went un-mergeable within the hour (more than 180 commits touched the file in one day), and each fix started
every CI job again.

Commands (`scripts/decisions.ts`):

- `bun run decisions`: the files here, newest first, with date, status and title.
- `bun run decisions:check`: fails on a file here without the header above (or with a name or date that do not match),
  a merge marker here or in the archive, and, on a pull request, a PR that adds a section or lines to
  `docs/DECISIONS.md` (compared with the base branch as `bun run changelog:check` does; the release PR, dev into main,
  is compared with dev). A change to the archive's top note, or a typo fix that keeps the number of lines, passes.
  Locally there is no base and that part is skipped; `DECISIONS_BASE=origin/dev bun run decisions:check` compares
  with a ref. `bun run check:docs` runs it, so CI does, and it checks the local links (and anchors) in these files.
