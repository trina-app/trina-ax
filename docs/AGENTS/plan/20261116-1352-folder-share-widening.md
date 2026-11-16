# Folder sharing, the widening checks (PR 3 of the folder-sharing design)

- Date (UTC): 2026-11-16 13:52
- Branch: `feat/folder-share-widening` (stacked on `feat/folder-share-server`)
- Status: in progress
- Where: Team AX core (`server/src/files/`, `server/src/chat/read-scope.ts`, `server/src/chat/widening.ts`,
  `server/src/team-files/`, `server/src/tools/`, `server/src/rooms/ai-grants.ts`, `server/src/devenv/srt/`,
  `server/src/admin/folders.ts`, `shared/src/api/files.ts`, `docs/decisions/`). Why: files, permissions and sharing are
  core (docs/REPOSITORY-RULES.md).
- Version impact: minor. No migration. Two optional request fields (`confirm` on the version restore,
  `?confirm=1` on the trash restore). Nobody can share a folder yet: the gate stays closed until the web part.

## Goal

The design is `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`, revision 2, after
security review 1). This branch builds what that file gives to PR 3: every place that decides "more people will see
this" counts the people of a folder share, every writer into a shared folder asks first (or, for the dev environment,
cannot write there), and a guard test lists every place that counts readers.

## Scope

In:
- `server/src/files/share-readers.ts`: `shareReaders`, `readersAt`, `readerCheck`, `privateToMe`, `shareAbove`, the
  readers of a share source, the owner's shared folders.
- W1 (C1): `placeKey` and `sourceKey` per share, so a read from a shared folder never hides a read from private files,
  in `widening()` and `roomWidening()`.
- W2 (M2): `sourceOf` tags a source with its share only where `receiverSees` lets a receiver open it.
- W3/W4: `viewersOf` counts a share source's people; every target's readers come from `readersAt`.
- W6 (H1): the dev environment's view makes the owner's shared folders read-only; a share add is refused while a run of
  the owner is alive (409 `folder_share_run_active`; the dialog's `blocked: run_active`).
- W7 (H3): a move into a shared folder asks whatever the client sends; `move_files` / `copy_files` count the share's
  people on their card; trash and version restores into a folder shared since ask (409 `audience_widened`);
  `generate_video`'s `save_as` gets the wider-audience card before anything is made; `save_url`'s own-folder shortcut
  becomes `privateToMe`.
- Scheduled runs (M3): decided at the write (no new code; tested).
- Engine sessions reset for people who stop reaching a shared folder (Stop, removal, pause, end, Remove all, a group
  leaver while folders are shared, a move out of the folder).
- Tests: `tests/unit/c-folder-share-widening.test.ts`, `tests/unit/c-reader-counters.test.ts`.

Out: the AI's reads inside a shared folder (PR 4), the screens and the gate (PR 5), `share_folder` (PR 6), team folders
by the AI (PR 7).

## Steps

1. `share-readers.ts`; wire `read-scope.ts`, `widening.ts`, `ai-grants.ts`, `embed.ts`, `TeamFiles`.
2. The writers: moves, copies, restores, `generate_video`, `save_url`.
3. The dev environment's view and the run-alive refusal.
4. Session resets.
5. Tests (the review's list first), the guard test, docs.

## Result

(Filled in when the work is done.)
