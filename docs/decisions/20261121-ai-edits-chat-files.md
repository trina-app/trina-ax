# The AI changes a chat file by saving a new version of it; the earlier one stays

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (builds on [20261121-shared-chat-output-to-chat-files.md](20261121-shared-chat-output-to-chat-files.md)
  and the "Left for later: shared chats with people" of [20261118-office-edit-in-place.md](20261118-office-edit-in-place.md)
  for edit_office on a chat's own files)
- Branch: feat/places-ai-versions (plan docs/AGENTS/plan/20261121-1240-places-ai-versions.md, P4 of
  docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md)

- **Ask:** "fix the date in the attached quote" in a chat shared with people: the AI said a chat file is not changed in
  place and made a copy in a team folder, which the others may not open.
- **Rule:** `write`, `edit` (and so `edit_files`) and `edit_office` without `output` on `chat:files/<file_id>/<name>`
  save a new version of that chat file (`ChatFiles.putVersion`, origin `ai`, the turn's write limits, the team's
  storage). The chain keeps its id, so every message, link and older answer's file_id opens the newest version; the
  last 20 versions stay, and `read` takes `versions: true` (the list) and `version: n` (that version as it was).
  Read before write as for a team file; a version someone saved after the AI's read stays, the AI's goes on top, and
  the AI is told.
- **Who:** the main AI of a chat shared with people, or of a personal chat that holds the chat file, while the asker may
  continue the chat. Refused in an answer with a k group (putVersion does not know the turn: the caller checks, before
  any card and again in the same synchronous step as the insert, with the chat as the database has it then), in a
  project chat (its chat files are read-only: owner, 2026-11-21), for a sub-agent, a guest, a scheduled run, a
  confidential chat and remote MCP.
- **edit_office in a shared chat:** offered, for the chat's own files only (a new version); a team Office file is not
  changed from a shared chat yet.
- **Left for later:** make_file, edit_pdf, comment_docx and resize_images writing a version of a chat file (they make a
  new file); `write` of a new `chat:files/<name>`.
- **Live update:** `chat/chat-file-version-hook.ts` (`onChatFileVersion`, `listenChatFileVersions`) is the seam the
  web's live update registers with.
- **Tests:** `tests/unit/places-ai-versions.test.ts`.
- **Version impact:** minor (the file tools take an existing chat file).
