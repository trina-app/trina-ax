# The AI's downloads, tools and previews go to the chat's work folder, never a team folder

- Date: 2026-11-21
- Status: accepted
- Supersedes: none. Amends [The chat's files and its work folder are paths of the AI's file tools](20261121-chat-places-as-paths.md):
  `chat:work/` exists in a project chat too
- Branch: fix/ai-scratch-files (plan [20261121-1842-ai-scratch-files.md](../AGENTS/plan/20261121-1842-ai-scratch-files.md);
  the owner, 2026-11-21: "how are there 14,000 files now? is that normal?")

- **Ask:** in a shared project chat on potenlab.trina.app the AI was asked to use the ppt-master skill. It downloaded
  the GitHub repo with `box_shell`, made a venv, rendered previews and made an export of the skill, all in the project
  folder (`_tools/`, 29,000 files, 337 MB on disk). One answer showed "파일 13220개 저장", and the AI then said it could
  not delete files. Claude Code would clone into a temp or work folder, not into the folder the team shares.
- **Rule 1, scratch:** a project chat's commands get `$TRINA_WORK` next to the project folder: the chat's own work
  folder (the person's private one in their own chat; in a shared project chat one of its own for the people who see it
  now, keyed like a shared chat's without a project, never the private one). It is writable, not a team folder and not
  recorded. `read`, `list`, `glob` and `grep` reach it as `chat:work/`. The tool text sends downloads, clones, installs
  (venv, node_modules), previews and every other scratch file there; only the finished files the person asked for go
  into the project folder. Third-party code is used from there with its source and licence named, and is not put into
  team or skills folders unless the person asks.
- **Rule 2, bulk guard:** when one answer's commands add more than 500 files or 200 MB of new files to a project folder,
  the command that crosses the line asks the person before its new files are recorded: keep them in the project folder,
  or move them to this chat's work folder (`$TRINA_WORK/from-project/<time>/`). "Always allow" (kind `bulk_files`) is
  on the first card and keeps them without asking from then on (the owner's Rule A: Always allow is final). The card
  waits 2 minutes (the project's other commands wait meanwhile); no answer (a scheduled run without that choice, a
  sub-agent, the timeout) moves them. A folder born during the command moves whole only when every file in it is the
  command's; what else changed while the card waited (a job's output) is recorded as background, not lost. Only the files that command created move,
  in the sandbox (a command with the AI's own folders), never by a server rename; a changed file never moves.
- **Rule 3, the summary card:** an answer's file summary lists at most 100 files; the rest come as a count per folder
  (`FileChangeSummary.more`). The header says the full count. A viewer of a shared chat sees only the folders whose files
  they may read, and only those counts.
- **Rule 4, own files:** `delete_files` puts the AI's own files of this chat in the trash without a card, also in a
  shared project chat, after other people's words, in a scheduled run and from Slack, up to 50,000 entries per call.
  Own: the item's recorded history starts with a create and every row is a create, update or delete by this person's
  turns in this chat (no move in, restore, upload, conflict, change found between commands or unknown author), and every
  file on disk below it has such a history, except files in a folder the dev environment does not record (node_modules,
  .venv …) born after the first create. Anything else keeps the normal rules: the card, 200 entries, no delete in a
  shared project chat. A restricted, template or confidential chat and a sub-agent never delete this way.
- **Why:** the AI should work like Claude Code (its scratch is its own), and a team folder only gets what people chose
  to keep. The guard catches a command that ignores the tool text; the card keeps the person's say, and Always allow
  ends the asking.
- **Left out:** a guard while a command runs (it acts at the end, before the files are recorded); changes found between
  commands (a job's output) are not moved, since that would break a running job: the AI gets a note when a job added
  more than 500 files, and the tool text sends job downloads to `$TRINA_WORK`; folders the snapshot skips
  (node_modules, .venv …) are not counted. The
  files already on potenlab are not touched: the owner deletes the project's `_tools` folder on the Files screen.
- **Tests:** `tests/unit/ai-scratch-files.test.ts` (scratch folder in project runs, tool text, bulk guard and move,
  summary cap, own-file deletes) and `tests/unit/ai-scratch-files-security.test.ts`.
- **Version impact:** minor (a new card and Always allow kind, a changed summary card).
