# A shared chat changes a team Word, Excel or PowerPoint file the asker may edit (S-028, TC-r2c-F1)

- Date (UTC): 2026-11-22 02:36
- Branch: `fix/shared-chat-team-file-edit`
- Status: in progress
- Where: server/src/chat (tools.ts, prompt.ts), server/src/rooms/ai-tools.ts. Why: the AI tool gate lives there.
- Version impact: minor (a tool works in a place it did not; no API change)

## Goal

Scenario QA S-028: in a chat shared with people, two people each asked the AI to change a team spreadsheet they can
both edit. The AI refused both ("이 채팅은 여러 사람이 보는 공유 채팅이라 … 여기서 바로 고칠 수 없어요") and nothing
reached the file. No decision forbids it: docs/decisions/20261118-office-edit-in-place.md lists "shared chats with
people" under *Left for later*, and docs/decisions/20261121-ai-edits-chat-files.md says a team Office file "is not
changed from a shared chat **yet**". edit_hwp and comment_docx already change a team file in place from a shared chat
(a new version, docs/decisions/20261119-audit1-shared-rooms.md). So this is a gap: close it the same way.

## Scope

In:
- `edit_office` on a team .docx/.xlsx/.pptx in a chat shared with people **and** in a shared project chat: without
  `output` a new version of the file (old bytes in its history, a conflict copy if someone saved after the read), with
  `output` a new file (as now in a personal chat). Same gates as edit_hwp / comment_docx:
  - runs with the asker's own file permissions (the turn's files; a read-only folder refuses with who can grant);
  - `file_path` counts as a read of the chat → the asker's read card when some people here cannot open it;
  - `output` is a write target → the save card when a place there already is one some people cannot open;
  - `confirmSources` (in the tool): content the chat read from a place some of the file's readers cannot open asks
    before it goes into the file; a replacement picture is a source too;
  - read-before-write, the turn's write limits, never under `skills/`, scheduled runs keep their own-places rule.
- A project chat now gets the tool (its chat files stay read-only: chatVersionRefusal already says so).
- One prompt line in the shared-chat section: to change a team Office file the asker names, read it, then
  edit_office without output; it saves a new version with the asker's access.
- Decision file, change note, tests.

Out: guests (no edit_office anywhere), sub-agents unchanged, tracked changes.

## Steps

1. Remove the refusal in chat/tools.ts (`edit_office && exec.shared && !versionAt`) and the project-chat exclusion.
2. Update the SHARED_TOOLS comment; add the prompt line (both shared kinds).
3. Tests (tests/unit/places-ai-versions.test.ts): bob edits `shared/…xlsx` in a people-shared chat → new version,
   cell changed; a team file in a folder some members cannot read → the read card first, "no" → unchanged; a read-only
   folder → refused, unchanged; a private file's text read in the chat → confirmSources card, "no" → unchanged; project
   chat offers edit_office and edits a project-folder workbook; its chat file still refused.
4. typecheck, check:prepush, area tests; real check on a private QA copy (claude-code engine).

## Decisions

docs/decisions/20261122-shared-chat-team-office-edit.md
