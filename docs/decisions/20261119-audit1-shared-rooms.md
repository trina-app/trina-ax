# Word comments in shared chats; room files read up to the read limit

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (adds comment_docx to the list in docs/DECISIONS.md "Shared project chats")
- Branch: fix/audit1-shared-rooms (limits audit 1 #22, #23)

- **comment_docx in shared chats (#22).** It works like edit_hwp, which shared chats have: an existing team .docx in,
  and out either a new version of the same file or a new .docx (`output`). The same gates apply to it.
  - The document path counts as a read of the chat (chat/tools.ts already maps it). A .docx that some of the chat's
    people cannot open gets the asker's read card first. Only the asker sees that card.
  - `output` is a write target (`WRITE_TARGET_ARGS`). It counts as a read only when a file is there already.
  - `confirmSources` runs in place too: comment text that came from a private file the chat read asks before it goes
    where more people see it.
  - Without a card nothing is changed (test: the original's bytes are the same after "no").
  - Still kept out of shared chats (safety, unchanged): memories, rooms, browser, personal Drive. Schedules and video
    stay out until there is a decision (see the PR's open items).
- **room_file (#23).** The size limit is the plan's read limit (`readMaxBytes()`, 200 MB without a plan), as for a
  team-folder read. It was 32 MB, while rooms take files up to 1 GB. The converters keep their own limits
  (files/extract.ts). Over the limit, the AI is told the limit in MB and that the person can open the file from the
  room.
