# A box command's changes in my own folder keep file versions; then a side chat's command needs no room card

- Date (UTC): 2026-11-22 14:36
- Branch: `feat/box-run-file-versions`
- Status: in progress
- Where: server/src/devenv (track.ts, snapshot.ts, tool.ts), server/src/chat/turn.ts. Why: the follow-up of
  [docs/decisions/20261122-ask-less-side-chat-runs.md](../../decisions/20261122-ask-less-side-chat-runs.md) rule 2
- Version impact: patch (a command's changes in the person's own folder become versions and trash items; one card
  fewer after a room read; no API or schema change)

## Goal

After a chat read a room, box_shell keeps the room card in the person's own chat and a ✦ side chat, because a run
writes the person's own folder `users/<me>/` straight to disk and nothing is kept: a room message could steer a command
that overwrites or removes the person's files for good. Make those changes undoable (the old content becomes a file
version, a removed file goes to the trash), then drop the card where everything the run can change is undoable.

## How a run sees the folders (checked)

- No copy and no sync back: srt binds team folders into the run and the run writes the disk directly
  (srt/access.ts). Writable: the start folder (a project chat's project folder, else the chat's work folder
  `$TRINA_WORK`, server-only scratch, never versioned) and the person's own folder (minus shared folders and skills,
  which are read-only; hidden in a project run whose project has other people). A shared chat writes no personal
  folder. Every other team folder is read-only. Chat files (`chat:files/`) are never in a run (only copies in
  `$TRINA_WORK`). The Claude Code engine has no Bash (engine/claude.ts CLAUDE_BUILTIN_DENIED): box_shell is the only
  command path.
- The project folder already has a change window (devenv/track.ts withChangeWindow: a hash manifest before and after
  each command, small files' content in a content store, the old content saved as a version). The own folder has none.
- So the hook is "before the command": the previous content must be in hand before the run starts. The window's start
  snapshot is that point; it re-reads only files whose size, mtime, ctime or inode changed since the last snapshot, so
  a second run costs a stat walk.

## Scope

In:
1. A change window for the person's own folder (`users/<id>`), one per person, around every foreground box_shell
   command of a chat that is not shared (project chat or not). Its own SnapshotStore under
   `<dataDir>/dev-env/own/<userId>` (server-only), with its own caps: a file up to **8 MiB** is kept, at most
   **256 MiB** in all; nothing is skipped by name except what the snapshot skips anyway.
   After the command: an update whose old content is kept -> `saveVersion` (file_versions, as the Files screen's save);
   a delete whose old content is kept -> a trash item (`.system/trash` blob + `trash_items` row, the team's retention
   days), restorable from the trash; a create -> a file event. Each change is a `file_events` row (`via: dev_env`) and
   is published (Files screen refresh). Saves from outside during the command are not the command's (the same
   `outside` map as the project window). The content store keeps only what the newest manifest names (old blobs are
   removed after each window), so it never grows past one copy of the folder's small files.
2. The project window gets the same delete rule (a kept old file goes to the trash, not only a version row of a path
   that no longer exists).
3. The AI's answer names what could not be undone ("changed, no earlier version kept (too large)").
4. The card: after a room read, a box_shell command goes on without the room card when (all of)
   the old `ownBoxRun` conditions (the person's own live chat, a ✦ side chat too; no project, not shared, not
   restricted or scheduled, not a guest, not confidential; no network in the command and "Allow all websites" off;
   a foreground command, not a job or a dev server), AND `ownFolderUndoable`: the own-folder baseline is taken now and
   every file there is kept (no file over 8 MiB, under 256 MiB in all, under the snapshot's file count, no folder the
   snapshot skips by name holding files: node_modules, .git, .env*, dist, build ...). Else the card stays, as today.
   The step says why: "내 폴더 변경은 버전으로 남아 묻지 않음".
   The card-time check is stat only (`keepable`: nothing is read, kept or saved; plan review must-fix 2); skills and
   shared folders, read-only in a run, do not count.
5. Fail closed at the run: a command let through on (4) runs only when the window's own start snapshot is still fully
   kept (a file grew meanwhile: the command does not run and the AI is told to ask; nothing changed).
5b. (plan review must-fix 4) A command let through on (4) that changes what the AI follows (skills, CLAUDE.md,
   AGENTS.md ...) or a hidden file in the own folder: the change is put back at once (the command's file to the trash),
   the AI is told, and the card is back for the rest of the answer (no loop).
5c. The AI's answer says what can be put back (versions, trash) and what cannot (QA: it told the person a deleted
   file was gone).
6. Decision file updated (rule 2 amended); changes/<topic>.md.

Out: jobs and dev servers (their changes land between windows; they keep the card); a run's changes in the background
between commands of the own folder are not recorded as the command's; changes under skipped names (node_modules, .git,
.env*) stay unversioned (they keep the card when present).

## Steps

1. snapshot.ts: SnapshotStore caps per store (fileMax, totalMax), `prune(manifest)`; takeSnapshot reports what it
   could not keep (`unkept`, `skippedDirs`).
2. track.ts: generalise the window to a "place" (project or own folder); own-folder recording (versions, trash);
   `ownFolderUndoable(ctx, userId)`.
3. tool.ts: wrap foreground commands of a not-shared chat in the own-folder window; refuse per (5); answer lines.
4. turn.ts: `ownBoxRun` back, with the undoable check; step note.
5. Tests (tests/unit/box-run-versions.test.ts): a run edits a file in my folder and in a project (team) folder, v1 is
   restorable; a run deletes a file, it is in the trash and restores; a big file keeps the card; a side-chat run after
   a room read has no card when everything is versioned; plus places-copy TC-f2-c02 updated.
6. Real check on a private QA copy with srt (colima) and claude-code.

## Decisions

Amends [20261122-ask-less-side-chat-runs.md](../../decisions/20261122-ask-less-side-chat-runs.md) rule 2 (updated in
place: same day, same topic).

## Risks

- Disk: up to 256 MiB of copies per person who runs commands (server-only, pruned to the newest manifest). Storage
  room check (assertStorageRoomForAI) still runs first.
- Time: the first command reads every file up to 8 MiB of the own folder once (then stat only). Commands of one
  person wait for each other (one own-folder window per person), as commands of one project do.
- Leaks: blobs are read with readInside (no link, the open file's real path inside the folder); versions and trash
  items are under the person's own path, visible to whoever may open that path (the person).
- No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/box-run-versions.test.ts, places-copy, dev-env track tests,
step-labels-shell.

## Result

(filled in at the end)
