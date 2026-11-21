# Edit a chat's files in place, with versions (S2, web)

- Date (UTC): 2026-11-21 12:06
- Branch: `feat/chat-file-edit-versions` (on #230's head `4bf6f1a9e`; rebased onto `dev` once #230 merges)
- Status: in progress
- Where: web (FilePanel, the chat's file tiles, the mock), shared API, and thin routes in `server/src/routes/chats.ts`.
  Why: the owner's rule: sharing a chat is for working together, so there is no view-only; people in a chat shared with
  people edit its files together.
- Version impact: minor. A new feature (edit, versions, restore) and new endpoints; nothing removed.

## Goal

In a chat shared with people, anyone who may open the chat's file edits a text file (md, txt, csv, html, json) in the
file panel. A save is a new version. The file's tile and the panel say "Updated by <name> · <time>" ("Updated by Trina
for <name>" for the AI's). The panel lists the versions (who, when, size); each opens, and "Restore this version" makes
a new head with its bytes. Nothing is ever deleted by a save or a restore (the server keeps the last 20).

## Scope

In:
- Thin routes over #230's P4 (`ChatFiles.putVersion`, `versions`, `restore`, `open({version})`):
  `GET /api/chats/:id/files/:fileId/versions` (the list and `canEdit`), `PUT /api/chats/:id/files/:fileId/content`
  (a person's save, `baseVersion` = the head the editor read; `beside` when someone saved in between),
  `POST /api/chats/:id/files/:fileId/versions/:version/restore`, and `?version=n` on the chat file read.
  After a save or a restore each person in the chat with a window open gets the carrying messages' tiles again
  (`message.attachments`, as they may see them; never for an answer hidden from them).
- `canEdit` (server): a chat shared with people (not a project chat: the project folder is its save place), not in the
  trash, safe operations off, a text name (md, markdown, txt, csv, html, htm, json), not on the download-only list, at
  most 10 MB. Binary files and project chats get no pencil.
- Re-share: a changed original that was copied before (`origin:'shared-copy'`, same `from`) becomes a new version of
  that chain (putVersion as the creator), and the copy's stored `fromSha256` moves to the new bytes. No second copy.
- Hidden answers: every route answers through `ChatFiles.open` / `versions`, which check the chain's ROOT carriers
  (P4). Someone the root is hidden from gets the 404 of a missing file: no version, name or count.
- Web: pencil + editor for chat files (FilePanel), "Updated by" line on the tile and in the panel header, a versions
  list (Open, Restore this version), the panel re-reads when the file's head changes. i18n in 6 languages.

Out: the AI's own writes telling other windows live (P4's putVersion in a turn; the answer's message.done covers its
own answer); diffs between versions; editing on a phone beyond prose (as team files: md and txt only).

## Steps

1. Plan (this file).
2. Shared API: the endpoints, `ChatFileVersions`, `SaveChatFileBody`, `ChatFileSaved`; `version` on `ChatFileQuery`.
3. Server: the routes (routes/chats.ts) + `chat/chat-file-edit.ts` (canEdit, the save, telling the chat); re-share in
   `chat/chat-files-share.ts copyMade`. Security matrix cases; a server unit test for the routes and the re-share.
4. Web: FilePanel chat edit + versions, tile line, i18n; the mock.
5. Web unit tests; e2e at 1440 and 390 (edit → save → Bob sees "Updated by"; versions → restore; a viewer the root
   is hidden from sees no versions; a project chat has no pencil). Screenshots light and dark.
6. typecheck, check:prepush, check:i18n, check:docs, docs:api, tests/security, web unit, e2e.

## Decisions

None new: the split, the chain id, "Updated by", restore-as-new-head, 20 kept and re-share-as-version are the plan
`docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md` "After the independent review".

## Risks

- No migration (P4 owns 432_b).
- Permissions: every route goes through ChatFiles (root carriers, seesChat, writable). The save refuses a project chat
  and a non-text name on the server too, not only by hiding the pencil.
- A save while someone else saved: both kept (`beside`), the panel says so.

## Tests

`bun run typecheck`, `check:prepush`, `check:i18n`, `check:docs`, `docs:api`, `tests/security` (people-shared-chats,
share-chat-files, permission-matrix), the new server test, `web` unit tests, the new e2e spec at 1440 and 390.

## Result

(at the end)
