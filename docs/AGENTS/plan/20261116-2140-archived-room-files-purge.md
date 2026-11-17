# Files of a conversation nobody is in any more are removed 30 days after it closed

- Date (UTC): 2026-11-16 21:40
- Branch: `feat/archived-room-files-purge` (off `dev`; independent of the other room-files PRs)
- Status: done
- Where: Team AX core (`server/src/rooms/files.ts`, `server/src/routes/rooms.ts`). Why: conversations and storage are
  core (docs/REPOSITORY-RULES.md).
- Version impact: patch. No migration, no setting, no screen.
- Parent plan: "Files sent in conversations, like Slack" (reviewed 2026-11-16), phase P3, the archived-conversations
  part.

## Goal

A conversation is archived when its last member leaves a group chat or when its group is deleted (`rooms/service.ts`
`dropMembers`, the team-room sync). DMs are never archived. Nobody can open an archived conversation and there is no way
to bring one back (`archived_at` is only ever set), yet its files stay on the team's disk forever, counted in "Files
in conversations" and in every backup. After this they are removed 30 days after the conversation was archived. Slack
removes a deleted channel's content at once; 30 days matches the set-aside folder the team already has.

The 30-day purge of the set-aside folder (`.system/rooms-orphans/`) runs only at start today; it runs daily too.

## Scope

In:
1. `RoomFiles.purgeArchived(now)`: rows of `room_files` whose conversation has `archived_at` older than 30 days
   (`ORPHAN_KEEP_MS`) are deleted (RETURNING id, room_id), then each file and its thumbnails, then the conversation's
   empty folder. Unsent uploads of such a conversation go too. The messages stay (nobody reads them; "messages are never
   removed"). The clock guard of `purgeOrphans` applies (a clock earlier than the newest room file: nothing).
2. Run daily: `sweep()` (the rooms' one-minute tick, `routes/rooms.ts:38`) runs `purgeArchived` and `purgeOrphans`
   once per 24 h (an in-memory time; the first tick after a start does it, so a restart also runs them, as today).
   Batches of at most 500 files a run, so one big conversation does not hold the tick.
3. Logged as today's room-file checks are (`room files checked`): counts only. No audit row: the conversation was
   already audited as archived (`room.archive`), and a count adds nothing for the owner.
4. Docs: `docs/site/*/use/admin.md` (six languages): one clause after the "Files in conversations" sentence. Decision
   file; `changes/archived-room-files-purge.md`. `docs/DECISIONS.md:8473` ("a purge is for later") is an old entry: the
   new decision says it is superseded (the archive is not edited).

Out: moving an archived conversation's folder into the set-aside folder at archive time (the parent plan's idea): the
files would leave "Files in conversations" at once, but the rows would stay and every start's check would count them
as missing; deleting after 30 days is simpler and loses nothing (nobody can reach them). So for 30 days those files
still count in "Files in conversations". An un-archive. Any screen.

Added on screen: nothing. Removed: nothing.

## Steps

1. `files.ts`: `purgeArchived`, a `lastDaily` time, `sweep` calls both daily; header comment.
2. Tests (`tests/unit/b-rooms.test.ts` or a new `b-rooms-archived-purge.test.ts`): a conversation archived 31 days ago
   loses its files and rows, its messages stay; one archived 29 days ago keeps them; a live conversation keeps them; a
   wrong clock keeps them; the daily rule (a second sweep within 24 h does nothing; a set-aside batch older than 30 days
   is purged by the sweep, not only at start).
3. Docs, decision, changes.

## Decisions

`docs/decisions/20261116-archived-room-files-purge.md`.

## Risks

- Deleting is final. Only conversations nobody can open, after 30 days, with the clock guard.
- A restored database that is older than the archive: the room is not archived there, its rows are there, the files are
  gone: those files answer 404 (as a missing file does today, counted at start).
- The tick's cost: one indexed query a day (`rooms.archived_at` is not indexed, but rooms are few).

## Tests

`bun run typecheck`, `check:docs`, the rooms server tests (Bun 1.3.12), the storage test.

## Result

Built, with the spec review's changes (a fresh subagent; it confirmed nothing reads or revives an archived room):
- DMs are never archived (the Goal line was wrong); recorded under Later in the decision.
- The delete uses `id IN (SELECT … LIMIT 500)` (not `DELETE … LIMIT`), in batches within 2 s; a cut-short run goes on at
  the next tick.
- The query checks "no member" itself; nothing when the team folder or the room files folder is not there; the clock
  guard also looks at the newest archive; a clock set back restarts the day; `reconcile` counts as the day's run.
- The docs clause is a paragraph of its own (Admin › System help, six languages); deleting a group says files go after
  30 days (the confirm in six languages, the AI's `group_delete` description).
- Risks correction: `room_files` has no `room_id` index; a scan a day is fine.
After the diff review (a second fresh subagent): `reconcile` no longer counts as the day's run (a server restarted
nightly would never purge); each purge has its own try/catch and a file that cannot be removed is logged, not thrown;
batches of 100; tests for the clock guards (archive and file), no room files folder, a run cut short, a clock set back
and thumbnails; the group-delete words say "if the group has a conversation" (the welcome team group has none).
