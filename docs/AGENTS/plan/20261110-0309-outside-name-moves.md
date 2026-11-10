# A planted name keeps its outside mark when it moves

- Date (UTC): 2026-11-10 03:09
- Branch: `fix/outside-name-moves`
- Status: in progress
- Where: Team AX core (`server/src/chat/turn.ts`, `server/src/files/timeline.ts`). Why: the outside-content mark is a
  core permission rule (docs/REPOSITORY-RULES.md).
- Version impact: patch (a fix to #275's name tracing; no API, data or setting change)

## Goal

Since #275 a new file in the person's own folder needs no card after a room read, so the AI names it, and the names a
later chat is shown carry the mark of the AI turn that made them (`noteOwnNames`). A review found that the mark was lost
as soon as the name moved: the person moved or copied the file, renamed its folder, or a clean chat copied or moved it.
Then a later listing showed the planted name in a clean chat and `remember` kept it without a card.

## Scope

In:

1. Name tracing walks a name's history back while the name stays the same: moves, a folder above moved or renamed,
   restores, and copies (in the source as it was at the copy). The mark is the one of the event that gave the name (a
   create there, or a move or rename that changed it). The same for folder names. A trailing " (2)" or a conflict copy's
   words keep the name.
2. `files/timeline.ts`: the walk says when it was cut short (its entry limit or its 40 reads); a cut-short history counts
   as outside, for names and for content.
3. The room card for `edit_hwp` names the output as the tool writes it (`hwpTarget`): `x.hwp/` saves x.hwp, an empty
   output `.hwpx` at the team root.

Out: everything else of #275; the schedule PR's own-folder rule (#284 replaces it itself).

## Steps

1. Plan (this commit).
2. `fileTimelineWalk` (cut flag, `before`), `fileNameLevel`, `folderNameLevel`, `childNamesLevel`, the card's input.
3. Tests: the four probe cases and a folder move or rename; DECISIONS, CHANGELOG.

## Risks

- More own-folder reads and listings may count as outside (a name made by a marked answer and then moved by the
  person): more `remember` cards there, never fewer.
- A walk per name shown: a listing of a big folder (over 500 files) counts as outside rather than walking each.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`; the fewer-cards suite, b-chat-rooms, room-ai-grants, b-chat,
project-taint, the security permission matrix.

## Result

Filled in at the end.
