# Share a chat's files with the people in it (first version: people-shared chats)

- Date (UTC): 2026-11-21 02:49 (scoped to the first version after review, same day)
- Branch: `feat/share-chat-files` (the plan was reviewed on `plan/share-chat-files`, c4a02ef0a)
- Status: in progress
- Where: Team AX core (`server/src/chat`, `web/src/components`). Why: sharing and chat files are core
  (docs/REPOSITORY-RULES.md).
- Version impact: **minor**. New optional API fields and one new chat route pair (`file-access`); no migration; no
  existing behaviour is narrowed.

## Goal

The owner's case (2026-11-21): the owner shared an existing Trina chat with one person. Earlier in that chat Trina had
made `견적서_Sincere_마케팅에이전트.pdf` and its HTML in the owner's own folder (`users/<id>/견적/Sincere`). The other person
clicks the file in the chat and the side panel says "The file can't be found, or you don't have access to it." There is
nothing they can do.

The owner's rules: sharing a chat is for working together, so there is **no view-only tier**; **ask at share time**
(as Gmail asks "share these Drive files?"); files made later in the chat just work (that part is session e6's, below).

## Today (origin/dev df07c450b)

1. A personal chat writes its files in the person's own folder `users/<id>/…`. That folder is private by path to
   everyone, admins too.
2. Share… (`PUT /api/chats/:id/audience`) says nothing about those files.
3. A file link in an answer opens the panel through the folder rules: someone else gets a 404 (`preview.notFound`),
   with no button and no way to ask.
4. Chat files (`chat_files`, migration 400) already belong to a people-shared chat: whoever sees the chat opens them.
   A row that no message names is an unsent upload: only its sender opens it, and the sweep removes it after a day.

## Scope of this version (the reviewer's smallest first version; no migrations)

### 1. The Share step (people-shared chat)

- When the creator opens Share… and the chat has **made-here files**, the dialog shows
  "Share the files from this chat too?" / "이 대화의 파일도 공유할까요?" with the list and two buttons,
  [Share without files] [Share with files] / [파일 없이 공유] [파일과 함께 공유].
- **Made-here files** (`chat/chat-files-share.ts` madeFilesOf), only from the server's own records:
  - `madeInChat` (chat/shared-actions.ts) accepts the path for the chat's creator: this chat's turns made it with
    write/edit/make_file/edit_hwp/stamp_pdf, nothing relocated, nothing else touched it since;
  - in the creator's own folder (`users/<creator>/`), not in a dot folder (`.attachments`), not a skill or an
    instruction file;
  - a plain file (one link) of at most `CHAT_FILE_MAX`, not on the download-only list, whose newest file event's
    sha256 is known;
  - not already in the chat as a copy of the same path and sha256 (dedupe: sharing again makes no second copy).
  - "Used here" files and the team-file line of the reviewed plan are dropped.
- The step also shows when Share is opened on an **already-shared** chat that still has such files, with the line
  "n files from this chat are only in your files" (review H4: the owner's chat is already shared).
- **Share with files** copies each file as a chat file (the `copyEarlier` way: read from one descriptor that follows
  no link, a picture's metadata cut out) and **attaches it to the answer that made it** (H2: the turn of the path's
  `create` event, its `turns.message_id`). Attached, the row counts as sent, so migration 400's sweep leaves it and
  everyone in the chat opens it. The source is a mark in the attachment JSON, as agreed with session e6:
  `origin: 'shared-copy'`, `from: <path>`, `fromSha256: <sha256>`. No new columns.
- **The chat's copy wins in links** (M5): inside that chat, a link to the source path opens the chat's copy for
  everyone, the creator included, so nobody edits two different files by accident. The AI of whoever runs a turn
  there is told the same in the transcript (the copy's file_id; read it with `chat_file`).
- **Re-check at the press** (M2): the confirm key binds every listed (path, sha256). At the press the server runs
  madeFilesOf again, reads each file from its open descriptor, hashes the bytes it read and compares them with the
  sha256 in the key. Anything different (a file changed, moved, gone, a new one): nothing is saved or copied, and the
  answer is the step again ("confirm", reason `changed`). New bytes are never copied silently.
- The step says the chat's copies go when the chat is deleted, and the originals stay in My files.

### 2. The panel's dead end becomes an ask (people-shared chat, H4)

- In a people-shared chat, a viewer who clicks a file link they cannot open gets, in the panel,
  "Only <creator> can add this file to the chat" with [Ask to add it] / [추가 요청].
- `GET /api/chats/:id/file-access?path=` answers `ask` (the creator's name and the name recorded in the chat), `asked`
  (the date), `copy` (the chat already has it: the panel opens the copy) or `no`. It answers `ask` only for a path
  madeFilesOf lists for this chat. Every other case (not in the chat's records, someone else's file, a team folder,
  gone, too large, a guest, the creator) is the one generic `no`, shown as today's "can't open" text. It never says
  that a path exists, whose it is or what folder it is in (M1, L1, L2). 60 reads a minute per person.
- `POST /api/chats/:id/file-access` sends the ask: an `access_requests` row (kind `chat`, target
  `<chat id>/<sha256 of the path, 32 hex>`, the path and name in `message` as JSON) and the creator's
  `access.requested` Activity row. The limits are the access requests' own (one waiting per person and file,
  FILE_REQUESTS_PER_OWNER_DAY a day to one owner, FILE_REQUESTS_PER_HOUR an hour in all).
- The request is untrusted (H3). On [Add to the chat] in Activity the server runs **the same check as the share
  step** (madeFilesOf for the path, own file, the sha256 of the bytes read against the newest file event) and copies
  only then. It answers from server records (file_events, the copies' marks), never from links in answer text. The
  notice names the file by the name recorded in the chat, never the current path.
- When someone leaves the chat (taken out of the audience, or the chat made private again), their waiting asks there
  are closed (M3). An ask whose asker no longer sees the chat, or whose file no longer qualifies, closes when read.
- The asker hears the answer in Activity: added (a link to the chat) or "wasn't approved" (no name), as today.

### Not in this version (follow-ups)

- **H1: new AI output in people-shared chats** attached as chat files, and AI edits of chat files saved as new chat
  files: session e6 (`fix/ai-sees-and-saves-workspace-output`, its PR2/PR2b).
- Version chains of chat files and people editing a chat file in place.
- Routing an ask to admins or to a file owner outside the chat.
- Team projects (the project folder copy at share time and when people are added).
- Per-file checkboxes, and "used here" files.

## Review findings this version answers

| Finding | Where |
|---|---|
| H2 copies must be attached or the sweep removes them | 1, "attaches it to the answer that made it" |
| H3 a request is untrusted input | 2, the same check at [Add to the chat] |
| H4 the owner's chat is already shared | 1 (already-shared step) and 2 (panel ask) |
| M1, L1, L2 no probe, no names, no folders | 2, one generic `no` |
| M2 re-check at the press | 1, key binds (path, sha256), bytes hashed from the descriptor |
| M3 leaving cancels waiting asks | 2, closed in the audience save |
| M5 two copies of one file | 1, the chat's copy wins in links |

## Steps

1. This plan, first commit.
2. Server: `chat/chat-files-share.ts` (madeFilesOf, readVerified, copyMade, fileTarget helpers), a small public
   `keepCopy` in `chat/chat-files.ts`, the made files in the Share check and key and `withFiles` in
   `chat/people-share.ts`, the file asks in `chat/access-requests.ts`, the routes in `routes/chats.ts`, the copies in
   the shared transcript (`chat/shared.ts`).
3. Shared API: `ShareCheck.madeFiles`, `ChatAudience.madeFiles` / `madeFilesKey`, `PutChatAudienceBody.withFiles`,
   `filesAdded`, `Attachment.origin` / `from` / `fromSha256`, `ChatFileAccess`, `accessRequest.file`.
4. Web: the step in `ChatShareDialog.tsx`, the copy map and the chat for links (`Markdown.tsx` ChatLinks, provided in
   `pages/Chat.tsx`), the panel ask (`ChatFileAsk.tsx` from `FileBody.tsx`), the Activity row, i18n in 6 languages.
5. `docs/decisions/20261121-share-chat-files.md`, `changes/share-chat-files.md`.
6. Tests (below), screenshots, PR into dev (not queued). Merge after e6.

## Coordination

- Session e6 edits `server/src/chat/chat-files.ts`, `chat-file-tool.ts`, `turn.ts` composeMessage and web
  `Messages.tsx` AssistantMessage, and merges first. This branch adds one small method to `chat-files.ts`, touches
  none of the others, and puts its link handling in `Markdown.tsx` / `pages/Chat.tsx`. e6's `origin: 'ai'` and this
  branch's `origin: 'shared-copy'` share one optional field of `Attachment`.

## Tests

`bun run typecheck`, `check:prepush`, full `tests/unit` and `tests/security`, web unit and e2e.

- Unit (`tests/unit/b-share-chat-files.test.ts`): the eligibility list (made here, own file, not relocated, not too
  large, dedupe), the re-check at the press (changed bytes, a new file → confirm again, nothing copied), the sweep
  leaves attached copies, a probe gets the generic answer, the ask and [Add to the chat], waiting asks closed when
  someone leaves.
- Web e2e (`web/test/e2e/share-chat-files.spec.ts`, mocked server, 1440 and 390): owner shares → step → member opens
  the copy and their AI reads it; already-shared → step; blocked → ask → add.

## Result

(filled in at the end)
