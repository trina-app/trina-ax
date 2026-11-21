# Versions of chat files (server core of P4, chat places as paths)

- Date (UTC): 2026-11-21 06:46
- Branch: `feat/chat-file-versions` (off #207's head 785a2c4df; rebased on dev once #207 is in)
- Status: in progress
- Where: server (`chat/chat-files.ts`, `chat/store.ts`, one migration), shared (`api/entities.ts`). Why: P4 of
  [20261121-0615-chat-places-as-paths.md](20261121-0615-chat-places-as-paths.md) ("After the independent review",
  must-fix 2 and 7); S2 of [20261121-0249-share-chat-files.md](20261121-0249-share-chat-files.md) (web) builds on it
- Version impact: **minor**. A chat file can get new versions (additive migration, a new optional API field); nothing
  that works today is narrowed

## Goal

A file kept with a chat (an upload, an AI-attached file, a share-time copy) can be changed without losing the old
bytes: every save is a new version, the chip and every link open the newest, and the old ones stay in the chat. This
PR is the server core that the AI's `write`/`edit` on `chat:files/<name>` (the P1 resolver), the web's save and
restore (S2) all call. No tool or web change here.

## Scope

In:
- Migration `432_b_chat_file_versions.sql`: `chat_files.replaces`, `root_id` (indexed), `version`, `origin`.
  `version` gives a stable number for `version: n` (pruning would shift a counted one); `origin` keeps "Trina for
  <person>" for a version (a root's origin stays in the message's attachment).
- `ChatFiles.putVersion(userId, rootId, bytes | checked fd, origin, opts)`: the only writer of a version. Streams to
  disk, `assertStorageRoomForAI`, the turn's write limits when a turn writes, keeps the last 20 rows per chain (the root,
  the chain's identity that messages carry, is kept; pruning never removes the head). Rows go with the chat.
- Chain id = the root's file_id. `open`, the thumbnail, `find` (by id, root or version id, or by name), the chip
  (`attachmentsOf`) resolve root → head.
- `sent()`, `onlyOnHidden()` and the sweep use the root's carrier messages. The uploader's unsent exemption holds only
  for a root (`replaces IS NULL`). The sweep never deletes a version on its own (a root swept unsent takes its chain).
- `ChatFiles.visibleTo(userId, chatId)`: one filtered list (one entry per chain, its head) for list, grep and the name
  lookup; a name carried only by hidden answers never shows. `find()` uses it; `findChatFile` in chat-file-tool.ts too.
- `versions(userId, chatId, id)` and `openVersion(userId, chatId, id, n)` for `read {versions}` / `version: n`;
  `restore(userId, chatId, id, n)` = putVersion of version n's bytes (a new head).
- `copyForViewer` strips `fromSha256` from every attachment and `from` from anything but the creator's shared copy,
  version rows included; a version entity never carries either.
- `Attachment.updated` (API): the head's person, time, version and whether the AI made it, for the web's "Updated by".

Out: the resolver and `read` (P1, feat/places-resolver-read), the AI's write/edit tools (P4 tool part), the web (S2).

## Steps

1. Plan (this commit).
2. Migration and row type; chain helpers (`rootOf`, `headOf`, `chain`).
3. putVersion, pruning, restore, versions; visibleTo/find; open/sent/onlyOnHidden/sweep/discard/ownByIds on the root.
4. store.ts chip resolution and copyForViewer; entity field.
5. Tests `tests/unit/b-chat-file-versions.test.ts`; typecheck, check:prepush, area tests under Bun 1.3.12.

## Decisions

Within docs/decisions/20261121-share-chat-files.md and the P4 plan; no new decision file (the plan's decision file
comes with P1).

## Result

(filled in at the end)
