# Changelog fragments

A pull request does not edit `CHANGELOG.md`. It adds its notes here, as one new file:

```
changes/<topic>.md
```

- `<topic>`: the branch name without its prefix (`fix/room-file-pdf-pages` → `changes/room-file-pdf-pages.md`), so two PRs
  never write the same file.
- Content: one or more notes, each a line that starts with `- `, in the style of "## Unreleased" in
  [CHANGELOG.md](../CHANGELOG.md): what changed for the user, in plain words. A line without `- ` goes on with the note
  above it.
- A PR with no user-visible change adds no file.

Example, `changes/schedule-once-default-day.md`:

```markdown
- Changing a scheduled task to **Once** now suggests today in the team's time zone. It took the UTC day.
```

Why: when every PR added a line at the top of "## Unreleased", two open PRs conflicted on the same lines. Each fix
started every CI job again (the org runs at most 20 jobs at once), and a wrong fix left merge markers in the file.

Commands (`scripts/changelog.ts`):

- `bun run changelog`: the Unreleased notes as they will read (these files first, then the section in `CHANGELOG.md`).
- `bun run changelog:check`: fails on a merge marker in `CHANGELOG.md` or a file here, or a file with no note.
- `bun run changelog:fold`: before a release, moves these notes under "## Unreleased" in `CHANGELOG.md` and deletes the
  files. Only the release owner runs it, on the branch for the release ([RELEASE-CI.md](../docs/RELEASE-CI.md)).
