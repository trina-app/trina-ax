# In a chat shared with people, the AI's finished file is attached to its answer

- Date: 2026-11-21
- Status: accepted
- Supersedes: none. Adds to [The AI opens what its commands made](20261121-ai-sees-and-saves-workspace-output.md) and
  [Commands run in shared chats](20261118-devenv-shared-chats.md)
- Branch: feat/shared-chat-attach-work-file (the owner, QA TC-6162)

- **Ask:** the owner's chat was shared with a teammate; the AI rendered a promo video and could not hand it over (a run
  there writes no team folder). Owner: a shared chat's result belongs to the chat, as an attachment.
- **Rule:** `save_work_file` in a chat shared with people (not a project chat, whose commands run in the project folder)
  attaches the work-folder file to the AI's answer as a chat file (`chat/chat-files.ts` createFromAi, the storage of
  people's chat files). Exactly the chat's people open it, so there is no place to pick and no card; anyone in the chat
  may put it into a folder later with `save_chat_file` and their own rights. Commands still write no team folder there.
  No `save_as` there (refused with the reason).
- **Who sees it, people added later:** as the sharing model says (DECISIONS "Shared chats everywhere"; since the 11-14
  rule "nothing new is hidden", which replaced the 20261118 line, k groups are the one exception): everyone who sees the
  chat sees its whole history and its files, also people added later. Before the copy, what a run there may read joins
  the answer's record with who sees the chat now (`noteSharedReads`), so the "adding people" warning counts the answer
  that carries the file. An answer with a k group (a connected service's answer hidden from people added later) carries
  no file: the attach is refused, and after an attach a k group is not recorded into that answer (the connection's read
  is refused). Right before the hand-off the work folder must still be the chat's people's now (sharedWorkOf).
- **The file:** streamed from the checked work-folder copy and moved in; a picture's place and camera cut out as an
  upload's; at most `CHAT_FILE_AI_MAX` (1 GB, shared/src/api/common.ts, as
  [Room files up to 1 GB](20261116-room-file-limit-1gb.md)) within the team's storage (`assertStorageRoomForAI`) and the
  turn's write limits; put into the answer row's `attachments` at once (a chat file counts as sent only when a message
  names it; the unsent sweep takes the others). The attachment JSON says `origin: 'ai'` (one optional field, also for
  copies of files from before a share: 'shared-copy'); no column, no migration. Uploads keep `CHAT_FILE_MAX` (50 MB).
- **Shown:** the answer shows its attached files as the same tiles as a message's own attachments, live (socket event
  `message.attachments`, to each person as they may see them; `message.done` carries them too). The transcript of a
  later answer names them by `file_id`, so "save that video to shared/" works with `save_chat_file`.
- **Not here:** new AI output with no place named in a chat shared with people (write, make_file into My files) is the
  next change; editing a chat file in place is the share-chat-files plan's S2.
- **Tests:** `tests/unit/work-file-attach.test.ts`.
- **Version impact:** minor.
