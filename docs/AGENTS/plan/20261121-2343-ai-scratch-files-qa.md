# AI scratch files: the QA walk's follow-ups (TC-7332, TC-7335..7338)

- Date (UTC): 2026-11-21 23:43
- Branch: `fix/ai-scratch-files-qa`
- Status: done
- Where: server/src/chat, server/src/devenv, server/src/rooms, web/src/components/chat. Why: follow-ups of #284 found by
  the QA walk on qa.trina.app.
- Version impact: patch (fixes to #284's own-file delete, its card wording and the files-saved card; nothing new)

## Goal

Rule 4 of [the AI's scratch files decision](../../decisions/20261121-ai-scratch-files.md) works where it was meant to:
in a shared project chat the AI puts its own files of this chat in the trash. The bulk card and the files-saved card
say true things in plain words.

## Scope

In:
1. TC-7332 (P2): `delete_files` joins `SHARED_TOOLS` (rooms/ai-tools.ts); the shared-chat prompt and the refusal no
   longer say the AI cannot delete there, only that other people's files stay. Confidential is checked before
   "shared" so an own-file call never goes past it. Turn-level test: the tool is offered in a shared project chat and a
   fake-engine call trashes the AI's own file there; a teammate's file is refused.
2. TC-7335 (P3): the bulk card says who sees the project folder (only you, the whole team or N people, from the real
   folder), the project's name instead of "My files › projects › …", no "(0.0 MB)" (KB under 1 MB, nothing under 1 KB),
   and the folders as name–count rows with no character count.
3. TC-7336 (P3): the box_shell tool text names the line (500 files or 200 MB) and tells the AI not to announce a
   question below it.
4. TC-7337 (P3): the files-saved card shows each file by its friendly place name (path on hover), and the overflow
   reads "N more files in M folders:" then "count · folder" rows, no "for example".
5. TC-7338 (P3): checked: deleting a personal project keeps its folder by design ("Only the project goes. Its files
   stay in My files › Projects."); a test pins that the files stay and are listed on the Files screen.

Out: anything else of #284.

## Steps

1. Plan (this commit), then the fixes in the order above, each with its tests.
2. typecheck, check:prepush, ai-scratch-files*, ai-delete-files, shared-chat tests, web file-summary, devenv tests.
3. One independent review for permissions and data safety; one PR to dev.

## Decisions

None new. Applies rule 4 of docs/decisions/20261121-ai-scratch-files.md as written.

## Risks

Permissions: delete_files is now offered in shared chats; every non-own call there is still refused up front
("shared"), never a card. Strings: en first, then ko, id, ja, es, zh.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/ai-scratch-files*.test.ts, ai-delete-files, b-chat-threads,
b-shared-chats, refusal-texts, web/test/unit/file-summary.test.tsx, dev-env tests.

## Result

Built as planned. TC-7332: the cause was delete_files missing from SHARED_TOOLS; the unit tests called the tool
directly, so nothing caught it. The new turn-level test (tests/unit/ai-scratch-files-shared.test.ts) fails without the
fix. The independent review found nothing blocking. From it: confidential is now checked before scheduled too, stale
comments are fixed, and a test covers a teammate's change. TC-7338 is by design: the confirm says the files stay, and a
test shows the Files screen lists them. PR: see the branch's PR to dev.
