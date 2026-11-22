# A shared chat changes a team Word, Excel or PowerPoint file the asker may edit (edit_office)

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (does the "Left for later: shared chats with people" of
  [20261118-office-edit-in-place.md](20261118-office-edit-in-place.md) and the "not changed from a shared chat yet" of
  [20261121-ai-edits-chat-files.md](20261121-ai-edits-chat-files.md) for team files)
- Branch: fix/shared-chat-team-file-edit (plan docs/AGENTS/plan/20261122-0236-shared-chat-team-file-edit.md; scenario
  QA S-028, TC-r2c-F1)

- **Ask:** in a chat shared with people, two people each asked the AI to change a team spreadsheet they can both edit.
  The AI refused both and nothing reached the file. No decision forbade it: it was left for later. edit_hwp and
  comment_docx already change a team file in place from a shared chat (20261119-audit1-shared-rooms.md).
- **Rule:** `edit_office` works on a team .docx/.xlsx/.pptx in a chat shared with people and in a shared project chat,
  as in the asker's own chat: without `output` a new version of the file (the old bytes in its history, a conflict copy
  when someone saved after the AI's read), with `output` a new file (a team path, or `chat:files/<name>` where the chat
  takes chat files). The main AI and its sub-agents, as for edit_hwp and comment_docx.
- **Gates (unchanged, now reached):** the asker's own file access (a read-only folder refuses); the document and every
  replacement picture count as reads of the chat, so a file some people here cannot open asks on the asker's read card
  first (`namedPaths` now lists `replace_picture.image`); `output` is a write target with the save card; the tool's
  `confirmSources` weighs what the chat read before it goes into the file; the room-change card (`widenOf`); a scheduled
  run's own-places rule (`RUN_WRITES`); read before write; never under `skills/`. A project chat's chat files stay
  read-only (owner, 2026-11-21).
- **Prompt:** one shared-chat line: change a team file the asker names where it is, with their access; do not refuse
  because the chat is shared and do not make a copy unless asked.
- **Tests:** tests/unit/b-shared-chat-edit-office.test.ts; tests/unit/places-ai-versions.test.ts.
- **Version impact:** minor (a tool works in a place it did not).
