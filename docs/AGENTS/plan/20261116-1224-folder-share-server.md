# Folder sharing, the server part (PR 2 of the folder-sharing design)

- Date (UTC): 2026-11-16 12:24
- Branch: `feat/folder-share-server`
- Status: in progress
- Where: Team AX core (`server/src/files/`, `server/src/team-files/`, `server/src/routes/files.ts`,
  `server/src/admin/groups.ts`, `server/migrations/`, `shared/src/api/file-shares.ts`, `docs/decisions/`). Why: files,
  permissions and sharing are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. New endpoints and one additive migration (reader level 1). Nobody can use it yet: the gate
  stays closed until the web part.

## Goal

The design is `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`; reviewed, revision 2).
This branch builds what that file gives to PR 2: a person's own folder can carry a share row, the people on it list the
folder and open the files inside it by the link id, view only. No screen changes; with the gate closed every folder
answers as it does today.

## Scope

In:
- Migration 360 (additive; 359 is taken by another open branch): `file_shares.kind`, `folder_id`, `paused_at`; `file_share_undos`.
- `server/src/files/share-places.ts`: places that are never shared (`neverShared`), what a receiver may see
  (`receiverSees`), the check of a path inside a shared folder.
- `server/src/files/folder-shares.ts`: who may share, the folder's identity (`saveFolderId`; no share on a disk without
  birth times; a mismatch pauses, the owner resumes), opening and listing a child as the owner, limits, one rate bucket.
- `server/src/team-files/stream-checked.ts`: a child's bytes come from the one checked descriptor.
- The folder's life: rename, move, trash, restore, purge, the owner or a receiver removed, a group deleted, the team
  switch, "Remove all file shares".
- An owner can always remove people and stop, also with the team switch off (files too).
- The server undo (`POST /api/files/shares/undo`), the API shapes, audit events.
- The gate (`config.folderShares`, off): nothing here is reachable by a user until the web part opens it.

Out (other PRs of the design): the widening hook and the dev environment rule (PR 3), the AI's read tools (PR 4), the
web (PR 5), `share_folder` (PR 6), team folders by the AI and Ask an admin (PR 7), the shared-files mark (PR 1), the
migration number check (PR 0). Engine session resets on losing access belong to PR 3.

## Steps

1. Find out whether a folder has a real birth time under Bun 1.3.12 on Linux (Docker, ext4 and overlay) and on APFS.
2. Migration, API contract, `share-places.ts` (pushed first: two other branches build on them).
3. `folder-shares.ts`, the stream helper, the routes, the small edits in `shares.ts`.
4. Lifecycle hooks, undo, group delete.
5. Tests the security review requires, then the design's own list for PR 2.
6. Decision file, changelog fragment, API reference.

## Decisions

`docs/decisions/20261116-folder-share-server.md` (written with the code): a member shares a folder inside their own
files; it replaces the "never a folder" points of the older decisions as the design quotes them.

## Risks

- Migration number 360 (358 is in #1118, 359 in feat/ai-share-card-and-stop-clean, 363 in feat/ai-share-who-can-open). Re-checked before merge.
- `shares.ts` is edited by two open batches (#1109, #1111); new code is in new files, the edits there are small.
- A disk without birth times gets no folder sharing.
- The feature must stay unreachable while the gate is closed: tested.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run docs:api`, the server tests under Bun 1.3.12:
`tests/security/folder-shares.test.ts` (new), `tests/unit/c-folder-shares*.test.ts` (new), and the existing
`tests/security/file-shares.test.ts` and `folder-sharing.test.ts` unchanged.

## Result

(Filled in when the work is done.)
