# The AI's scratch stays out of team folders

- Date (UTC): 2026-11-21 18:42
- Branch: `fix/ai-scratch-files`
- Status: done
- Where: server (devenv, chat), shared (api, tools), web (chat file summary). Why: a project chat's AI put a 13,000-file
  GitHub download into the project folder (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new card (many new files in a project folder), a new "Always allow" kind and a changed
  file summary under an answer.

## Goal

On potenlab.trina.app (0.7.0) a shared project chat was asked for a company intro deck with the ppt-master skill. The
AI downloaded the GitHub repo (hugohe3/ppt-master, MIT) with `box_shell`, made a venv, ran the skill's previews and
exported a copy of it. All of it went into the project folder, under `_tools/` and next to the deck: 29,000 files and
337 MB on disk, 20,012 file events, and a "파일 13220개 저장" card under one answer. The AI then said it could not
delete files, and the person had to clean up.

Root cause:

1. `box_shell` in a project chat starts in the project folder. That folder, the person's own folder (not in a shared
   chat) and /tmp are all it can write, and the tool text says /tmp is gone after each command. So there is no lasting
   scratch place: a download, a clone, a venv or a preview can only go into the team's project folder.
2. Every file a command makes there is recorded (devenv/track.ts change window): one file event each, a version, a
   publish, and a row in the answer's file summary. Nothing stops or asks about a command that adds thousands.
3. The file summary lists every row, so the card counts 13,220 files and its list renders all of them.
4. `delete_files` is refused in a shared project chat and stops at 200 entries, even for the files the AI made in this
   chat a minute ago.

## Scope

In:

- A project chat's commands get `$TRINA_WORK` too: the chat's own work folder (the person's private one in their own
  chat; in a shared project chat a work folder of its own for the people who see it, like a shared chat without a
  project). Writable in every command, not a team folder, not recorded. `read`, `list`, `glob` and `grep` take
  `chat:work/` there as they do in a chat without a project.
- The tool text: downloads, clones, tool installs (venv, node_modules), previews and other scratch go in
  `$TRINA_WORK`; only the finished files the person asked for go in the project folder. Third-party code is used from
  there, with its source and licence named; it is not put into team or skills folders unless the person asks.
- The bulk guard: when one answer's commands add more than 500 files or 200 MB of new files to a project folder, the
  person gets a card before those files are recorded: keep them in the project folder, or move them to this chat's work
  folder. "Always allow" (keep, never ask again) is on the first card. No answer (a scheduled run, a sub-agent, time out)
  moves them. Only the files that command created move; changed files stay.
- The file summary under an answer keeps at most 100 files in its list and says how many more there are, by folder. The
  count in the header is the full count.
- `delete_files` takes files the AI made in this chat: every recorded file under each path was created by this chat's
  answers and nobody changed it since. Those go to the trash without a card, in every chat kind except a sub-agent, a
  template run, a restricted or confidential chat, up to 50,000 entries per call. Anything else keeps the normal rules.

Out:

- The 13k files on potenlab stay where they are (the project's `_tools` folder). The owner deletes the folder on
  the Files screen. Nothing on potenlab is changed by this PR.
- A pre-command guard (counting writes while a command runs). The guard acts at the end of the command, before the
  files are recorded.
- Folders the snapshot skips (node_modules, .venv, dist …) are not counted; the tool text sends them to `$TRINA_WORK`.

## Steps

1. Plan (this file).
2. `devenv/srt/runner.ts`: a project chat's scratch folder (`scratchOf`), given to `srtSettings` and `runEnv` as the
   work folder of runs that start in the project folder; `workFolderAt` returns it for `chat:work/`.
3. `devenv/tool.ts`: tool text for project chats; the bulk guard after a tracked command (`devenv/track.ts`
   `withChangeWindow` gets a `bulk` hook that runs before the changes are recorded and can move created files away).
4. `chat/tools.ts`: the bulk card through `turnPerson` with Always allow `bulk_files`.
5. `chat/turn.ts fileSummaryOf`: cap the list, add `more` (count and folders); `shared` schema; web `FileSummary`.
6. `chat/delete-files.ts` + `team-files/service.ts planAiTrash`: own-made files.
7. Decision file, changes note, unit and security tests.

## Decisions

- [docs/decisions/20261121-ai-scratch-files.md](../../decisions/20261121-ai-scratch-files.md) (new).
- Amends [The chat's files and its work folder are paths of the AI's file tools](../../decisions/20261121-chat-places-as-paths.md):
  `chat:work/` also exists in a project chat.

## Risks

- Permissions: a shared project chat's work folder must never be the private one (settingsProblems checks it) and is
  keyed by who sees the chat, as for a chat without a project.
- Data: the guard's move only takes files created by that command and still the same on disk; the delete of own files
  checks the file history of every path, and goes to the trash (restorable).
- No migration. Five app languages for the new card and summary words.

## Tests

`bun run typecheck`, `bun run check:prepush`, unit tests for devenv, delete-files, file summary, and the new
`tests/unit/ai-scratch-files.test.ts` and security tests.

## Result

Built as planned, with the line at 500 files or 200 MB (not 300 / 100 MB) so a normal build or image folder does not
ask. After the independent review: the bulk card waits 2 minutes (the project's other commands wait while it is open),
what else changed while it waited is recorded as background, a folder holding a file the command did not make never
moves whole, `chat:work/` works in shared project chats, a cheap history check runs before an own-file plan walks the
disk, and a job that adds many files to the project folder gives the AI a note (jobs are not moved). The PR link is in
the PR.
