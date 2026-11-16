# A folder someone shares counts its people wherever "more people will see this" is decided

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (adds to [20261116-folder-share-server.md](20261116-folder-share-server.md))
- Branch: feat/folder-share-widening (the owner approved the design on 2026-11-16; QA TC-4077..4089, TC-4099..4105)

Design: `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`, revision 2, "The widening
hook"). Plan of this part: [20261116-1352-folder-share-widening.md](../AGENTS/plan/20261116-1352-folder-share-widening.md).

- **Ask:** before folder sharing, "who reads this path" was the folder rules alone, and inside a person's own folder
  the answer was always "only them". A folder they share has other readers. Every check that warns before content
  reaches more people must count them, and every way content gets into a shared folder must ask first.
- **Rule: one place answers who reads a path.** `server/src/files/share-readers.ts`: the folder rules plus the people of
  every live folder share at or above the path (paused ones too: a warning counts more readers, never fewer), only
  where a receiver could see the path (not a hidden, temp, project or skill place inside the folder). Every function
  that counts readers goes through it; `tests/unit/c-reader-counters.test.ts` lists them all and fails on a new one.
- **Rule: every distinct source is judged.** What the AI read from inside a shared folder is its own source per share
  (`{type: 'user', id, share}`); a read from the owner's private files stays the plain own-folder source. The two are
  never folded into one, so reading the shared folder first can never hide a later private read when the AI saves into
  the shared folder (security review 1, C1). The card still says "my files" once. A child a receiver cannot open
  (a dot-folder, a project or skill folder inside) is the plain source (M2). An older build ignores the `share` field
  and reads the source as "only that person", which asks more, never less.
- **Rule: every writer asks.** The AI's `write`, `edit`, `make_file`, `save_url` and room saves: the wider-audience card,
  as for team folders. `move_files` and `copy_files`: their card counts the share's people. `generate_video` with a
  chosen path: the card before anything is made or spent. A person's move or copy into a shared folder: the existing
  confirm, now also when the client does not ask for it (409 `audience_widened` without `confirm`). A trash restore or a
  version restore into a folder shared since the item was trashed or the version saved: the same 409, with the count,
  unless confirmed. Not asked, as decided: the person's own upload or new file in their own shared folder.
- **Rule: the dev environment never writes in a shared folder.** A run writes to the disk directly, with no single
  write to ask about, so the owner's shared folders are read-only in a run (the run's view and its hash change with the
  share). A share cannot be added while a run of the owner that could write there is running (409
  `folder_share_run_active`; the dialog reads `blocked: run_active`). The AI is told to write elsewhere and move the
  file in with `move_files`, which asks.
- **Rule: scheduled runs.** Decided at the write: without "Always allow" for wider saves the run saves nothing there
  (nobody can answer the card); with it, the save goes through, as for any folder more people see.
- **Rule: losing a share starts fresh.** People who stop reaching a shared folder (taken off, Stop, paused, ended,
  "Remove all file shares", leaving a group while folders are shared, the file moved out) get a fresh AI session on
  their next turn, as after a folder rule change.
- **Departures from the design:**
  1. `seesSource` (who may see a source's place named on a card) keeps "the person whose folder it is": naming the
     owner's folder to a receiver adds nothing and would name a place they open only by link.
  2. The run-alive check counts any running job, dev server or command of the owner: every run may write the owner's
     own folder, so "a run that can write there" is every run (a project run with other people, which cannot, is
     rare; it waits too).
  3. `sourceKey` (the memo of places the person allowed in an answer) also keeps the share apart: with one key the
     scope stored only the first of two own-folder reads and the private one was lost before any check.
  4. The design's `chats.shared_files_seen` is the `chats.others_words` mark of the #1109 batch (not used here).
- **Version impact:** minor (no migration; an optional `confirm` on the copy and the version restore and `?confirm=1` on the trash
  restore; nobody can share a folder until the web part opens the gate).
- **Tests:** `tests/unit/c-folder-share-widening.test.ts`, `tests/unit/c-reader-counters.test.ts`.
