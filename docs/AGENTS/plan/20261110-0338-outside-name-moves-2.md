# Outside names, round 2: an AI rename, a folder restored elsewhere, big listings

- Date (UTC): 2026-11-10 03:38
- Branch: `fix/outside-name-moves-2`
- Status: done
- Where: Team AX core (`server/src/chat/turn.ts`, `server/src/files/timeline.ts`). Why: the outside-content mark is a
  core permission rule (docs/REPOSITORY-RULES.md).
- Version impact: patch (fixes to #290's name tracing; no API, data or setting change)

## Goal

The re-review of #290 found two ways a planted name still lost its outside mark, and one way a listing could stall the
server.

## Scope

In:

1. **An AI rename keeps the old name's mark.** A clean chat's small rename (adding ".md", lowercasing with
   `rename_file`) took the renamer's mark (0) although the new name comes from the planted one. An AI turn's rename,
   move or copy that changes a name now carries the higher of its own mark and the old name's (files and folders). A
   person's rename still gives a name of their own.
2. **A folder restored to another place.** A folder restored as "… (restored)" (its place was taken) dropped the mark of
   the names inside it: the history walk followed a folder above when it moved, not when it came back from the trash to
   another path. It now follows that too (`files/timeline.ts`, and the folder-name walk).
3. **Big listings.** Tracing names has one budget per call (files and sub-folders together); past it the listing counts
   as outside. ~3,000 sub-folders took 97 ms on the server's thread before.
4. **A folder copy** (`copyFolderTree`, one event for the whole folder; nothing calls it today): the walk follows a file
   inside such a copy to its source, and the method says so.

Out: everything else of #275 and #290.

## Steps

1. Plan (this commit).
2. The four changes, with tests; DECISIONS, CHANGELOG.

## Risks

More names count as outside (a clean chat's rename of a planted name), and a listing over the budget counts as outside:
more `remember` cards there, never fewer. The file history screen now follows a folder restored to another place and a
folder copy (more of the file's past, as it was).

## Tests

`bun run typecheck`; the fewer-cards suite, b-chat-rooms, the file-history suites, the security permission matrix.

## Result

Built as planned: an AI rename (and an AI copy under another name) keeps the old name's mark; the walks follow a folder
above restored to another place and a folder copied as a whole; one budget of 500 names per call. The four new tests fail
on #290's code and pass here.
