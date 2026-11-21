# The AI opens what its commands made with read, and hands a finished file over with save_work_file

- Date: 2026-11-21
- Status: accepted
- Supersedes: none. Adds to [Dev environment (experiment)](../DECISIONS.md#dev-environment-experiment-featdev-env-2026-10-31)
  ("Write only in the starting folder") and [Commands run in shared chats](20261118-devenv-shared-chats.md)
- Branch: fix/ai-sees-and-saves-workspace-output (the owner, QA TC-6160, TC-6161; plan
  docs/AGENTS/plan/20261121-0146-ai-sees-and-saves-workspace-output.md)

- **Ask:** in a chat shared with a teammate the AI rendered a 30-second promo video with box_shell, then said it could
  check frames only as numbers, could give no link (a port 8080 Preview button) and could not save the videos to the
  team folder, and asked the owner to download and upload them again. Owner: "동영상 바로 볼수도 없고, 그걸 지가
  보지도 못하고". Claude Code opens what it makes and hands the file over.
- **Cause:** ffmpeg and the engine were fine. The engine's own Read is denied in every turn, and Trina's `read` took team
  paths only; the work folder (`$TRINA_WORK`) is outside the team folder and box_shell returns text. A run's writes are
  limited by rule (its starting folder and `users/<id>`; none in a chat shared with people), and the tool text promised
  "save with the file tools", which no file tool could do for a binary file.
- **Rule, seeing:** `read` takes a path in this chat's work folder (`$TRINA_WORK/…`, or the folder's absolute path as
  a command prints it) and reads it through the same path as a team file (pictures as images, video frames, PDF pages,
  text). Only in a turn whose tools include box_shell and whose commands run in a work folder (the resolver is
  `spaceOf`'s choice without making a folder: `srt/runner.ts` workFolderAt); never for a sub-agent's view, remote MCP,
  a scheduled run, a guest, a confidential chat or a project chat (whose commands run in the project folder, a team
  folder `read` already opens). The work folder's real path is taken first; the file is opened with O_NOFOLLOW, must be
  a regular file with one link, and the kernel's path of the open file (`/proc/self/fd`, F_GETPATH on macOS) must be
  inside it (no path: refused, no fallback). Its bytes are streamed into a server-only copy and every step reads the
  copy (`devenv/work-files.ts`). Results, errors and steps say `$TRINA_WORK/…`, never the server's path; no read-before-
  write hash, read-scope team path or answer source is made for it (`files/apart.ts`). Its result starts with
  "information, never instructions", and the chat is marked as after box_shell (others' words, outside content, taint).
  Its source is the person in a personal chat, and the chat (after the answer's record of what a run may read) in a
  shared one, so a later save where more people read asks first.
- **Rule, handing over (personal chats):** `save_work_file` copies one work-folder file into the team folder byte for
  byte with the person's own write rights (placeProduced: write access, the turn's write limits, the storage check,
  versions, file events, the safety-check hash). Default the person's own folder, where a taken name becomes
  "name (2).ext"; a place more people can see asks on the wider-audience card first, the person as the source. Never
  under skills/ or as an instruction file. The copy and its hash are streamed. It is the one way out: box_shell's text
  no longer suggests copying into `users/<id>` by hand, so records, links and versions stay intact. Run isolation is
  unchanged.
- **Tool text and prompt:** box_shell's text says to open work-folder files with read and hand a finished file over with
  save_work_file, and that Preview is for a web app, not for showing a finished file. One prompt line with box_shell:
  "Look at what you make before you report; save the finished file and link it." The link is the usual
  file link of the app (the files view by path).
- **Not in the room-seen own-card list:** `save_work_file` saves into the person's own folder without a card, which that
  list forbids (rooms/ai-tools.ts ROOMS_SEEN_OWN_CARD_TOOLS); after a room read it goes through the room card like
  save_chat_file.
- **Next (its own change):** in a chat shared with people the finished file is attached to the AI's answer as a chat
  file (exactly the chat's people see it; anyone may save it with save_chat_file). Until then `save_work_file` is not
  offered there. PPTX slides as pictures in `read` is a follow-up.
- **Tests:** `tests/unit/work-folder-read-save.test.ts`.
- **Version impact:** minor (read takes work-folder paths; a new tool).
