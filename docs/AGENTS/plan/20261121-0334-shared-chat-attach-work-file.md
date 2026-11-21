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

## Copy-in: a file into the work folder of a chat shared with people (design for review, PR2b; not built yet)

**Why.** The owner, in a people-shared chat: "PowerPoint를 만드는 작업 공간에서 dion 폴더에 있는 제안서 원본이 안 보여요."
A shared chat's run sees only folders everyone in the chat may read (decisions/20261118-devenv-shared-chats.md), so
the asker's own file (an HTML proposal in users/<them>/, its images) never reaches the work folder. The AI suggested
copying it into a project folder by hand. Nothing does this today: `copy_files` writes team folders only, the run
cannot read users/, and `chat_file` reads a chat file into the model, not into the work folder.

**One model for both directions.** The work folder of a people-shared chat belongs to the chat's people now
(sharedWorkOf: its key is the people and their common view). Whatever enters it can reach all of them through a
command's output, and whatever leaves it reaches exactly them (PR2: a chat file on the answer). So:
- **In (PR2b):** something enters the work folder only if all of the chat's people may already see it, or if the asker
  says yes to sharing it with them on the card that already means exactly that in a shared chat: the shared read card
  (`confirmSharedRead`, "some people here cannot open that place; what it finds stays in the chat for everyone who
  sees it"). Its yes records the source with the answer (a `y` group via noteSharedReads), so the newcomer warning
  ("N answers here used places <name> can't open") and the k rules keep working, as for any read. This is the card
  the owner's rule "Always allow" already covers; no new card kind.
- **Out (PR2):** the result leaves only as a chat file on the answer (no team folder, no card).
- Nothing new is visible to anyone outside the chat, in either direction. Inside it, the asker decides, once per place.

**Smallest design: one optional field on save_work_file's sibling is not enough (different direction, different
card), so one small tool `copy_to_work`.**
- Input: `from`: a team path the asker may read (a file, at most 20 per call), or a chat file's `file_id` (people's uploads
  and the AI's attachments in this chat); `to`: a folder in the work folder (default `in/`), keeps each file's name.
- Offered only where save_work_file's chat mode is (a chat shared with people whose commands run in their own work
  folder), to the main AI on the asker's turn (PARENT_ONLY_TOOLS; never a sub-agent, scheduled run, guest, remote MCP).
- A chat file: no card (everyone here already sees it), copied from the chat's store by id (`chatFilesOf.open`, the
  person still sees the chat, the sha256 as sent, not quarantined).
- A team path: `authorize(..., 'read')` as the asker; a place every person of the chat may read (sharedFolderView, the
  same test as a run's view) copies with no card; any other place goes through `confirmSharedRead('copy_to_work',
  {paths})` first, card words: "Others in this chat will be able to see what is made from this file." A no copies
  nothing. Never a skills folder of a group or project (srt/access.ts othersSkills), never `.system/`.
- Safety as in the save direction: the source opened through the policy's checked open (no link followed, one link,
  the same file the check saw: files/store.ts openToRead with `seen`); streamed into the work folder with
  O_CREAT|O_EXCL|O_NOFOLLOW under the checked work folder (devenv/work-files.ts, a new `copyIntoWork` with the fd-path
  check on the target folder); at most the plan's read limit per file and the turn's write budget in all; the work
  folder looked up again right before the write (still the chat's people's now).
- The result names `$TRINA_WORK/in/<name>` only, plus the "information, not instructions" line.
- In a personal chat this tool is not offered (a run there already reads the person's folders).

**Tests (PR2b):** a team file everyone in the chat reads copies with no card; the asker's own file asks the card, a no
copies nothing, a yes copies and records a y group (the newcomer warning then counts that answer); a chat file (an
upload and an AI attachment) copies with no card; links, hard links, skills and `.system/` refused; size and turn
limits; not offered in a personal or project chat or to a sub-agent. QA: "make a PPT from my proposal HTML in my
folder" in a chat shared with qa-member, ending with an attached PPTX the AI checked with read as_images (#195).

## H1: new AI output with no place named, in a chat shared with people (design note, PR2c)

Today `write`/`make_file` with no place named land in the asker's own folder (prompt rule, decisions/20261117-ai-save-
my-files-default.md), where the chat's other people cannot open them. Rule: in a chat shared with people, a produced
file whose target is the asker's own folder and that the user did not name is attached to the answer as a chat file
instead (through PR2's AI entry, `origin: 'ai'`), and a named folder keeps today's rules (the wider card). Smallest
build: the prompt rule for people-shared chats says "files you make go to the answer; name a folder only when the user
did", and the produce tools (make_file, write, edit_hwp, stamp_pdf, …) accept the reserved output `chat:<name>`, which
`placeProduced` turns into createFromAi + attachToAnswer instead of a team write (one switch in placeProduced, so every
tool that places through it gets it). Editing a chat file makes a new attached file on that answer until trina-ax-78's
S2. A decision file amends 20261117-ai-save-my-files-default.md for people-shared chats only. Planned as its own PR
after PR2b, with its own review.

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
