# Shared chats: the AI attaches its finished file to the answer

- Date (UTC): 2026-11-21
- Branch: `feat/shared-chat-attach-work-file` (on top of `fix/ai-sees-and-saves-workspace-output`, #198)
- Status: in progress
- Where: server (chat files, save_work_file, turn, history), shared (attachment, socket event, cap), web (answer chips). Why: the
  shared-chat half of docs/AGENTS/plan/20261121-0146-ai-sees-and-saves-workspace-output.md (PR2)
- Version impact: minor (save_work_file works in chats shared with people; answers show attached files)

## Goal

In a chat shared with people, a command's finished file (a video, a chart) reaches everyone in the chat: the AI
attaches it to its answer as a chat file (owner's choice: "shared chat = chat attachment"). Exactly the chat's people
see it, so there is no "where?" question and no card; anyone may later put it in a folder with save_chat_file and their
own rights. Commands still write no team folder there.

## Scope

In:
- `save_work_file` in a chat shared with people (not a project chat): no `save_as` (refused with the reason); the file
  becomes a chat file on this turn's answer. Before the copy: what a run there may read is recorded in the answer
  (`noteSharedReads`), the shared work folder is checked to be the same as `sharedWorkOf` now, and a turn whose answer
  has a k group (a connection's answer hidden from people added later, chat/shared-answers.ts) is refused, so a hidden
  answer never carries a file.
- `ChatFiles.createFromAi`: streamed (the copy from the work folder is already a server temp file; it is moved in), a
  picture's metadata cut (`cleanPicture`) only for pictures, at most `CHAT_FILE_AI_MAX` (1 GB, shared/src/api/common.ts,
  as decisions/20261116-room-file-limit-1gb.md), the storage check (`assertStorageRoomForAI`) and the turn's write
  limits; recorded, then put into the answer row's `attachments` at once (`sent()` holds; the unsent sweep never takes
  it). The attachment JSON gets one optional field `origin: 'ai'` (no column, no migration).
- The answer shows its attached files (the user message's `AttachmentView`, aligned left), live: a new socket event
  `message.attachments` to the person of the turn and to everyone who sees the chat (each as they may see it).
- History: an answer's attached chat files go into the transcript with their `file_id` (labelledTranscript), so "save
  that video to shared/" works later with save_chat_file.
- The newcomer warning counts the answer that carries the file (its read record), tested.

Out: H1 (new AI output with no place named goes to the chat instead of My files in people-shared chats) is PR2b, right
after this one; editing a chat file in place is trina-ax-78's S2.

## Steps

1. This plan. 2. Tests (`tests/unit/work-file-attach.test.ts`, a web unit test for the answer chips). 3. Code. 4. Decision
`docs/decisions/20261121-shared-chat-attach-work-file.md`, `changes/shared-chat-attach-work-file.md`. 5. QA in a
chat shared with qa-member: a short clip attached, both people open and play it, a newcomer warning.

## Risks

No migration. A file over 1 GB is refused in plain words. A shared chat's file reaches people added later (the
sharing model); the warning counts it. k-group turns are refused.

## Tests

`bun run typecheck`, `check:prepush`, the new tests, chat files, shared chats, dev-env shared, widening tests, under Bun 1.3.12.

## Result

(at the end)
