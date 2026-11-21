# Share a chat's files with the people in it (people-shared chats and team projects)

- Date (UTC): 2026-11-21 02:49
- Branch: `plan/share-chat-files` (plan only; the builds get their own branches, below)
- Status: draft (waiting for the owner)
- Where: Team AX core (`server/src/chat`, `server/src/files`, `web/src/components`). Why: sharing and chat files are
  core (docs/REPOSITORY-RULES.md).
- Version impact: **minor**. New optional API fields, two additive migrations, and a new kind of access request. No
  existing behaviour is narrowed.

## Goal

The owner's case (2026-11-21): the owner shared an existing Trina chat with one person ("2 people"). Earlier in that
chat Trina had made `견적서_Sincere_마케팅에이전트.pdf` and its HTML source in the owner's own folder (My files › 견적 ›
Sincere). The other person opens the file from the chat, and the side panel says "The file can't be found, or you don't
have access to it." There is nothing they can do about it.

The owner's direction:

- When a chat is shared, ask whether to share the chat's files too, the way Gmail asks "share these Drive files?".
- **No "view only" option.** People share a chat to work together, so everyone in the chat can open **and edit** those
  files.
- Files Trina makes later in a shared chat are usable by everyone in it, with no prompt each time.
- The panel's dead end offers **Ask for access**.
- The same applies to **team projects**: project chats and the project room, and adding someone to a project.

## Today (origin/dev f2cc8ed5c, reproduced on a QA copy)

1. A personal chat writes its files in the person's own folder, `users/<id>/…`
   (decisions/20261117-ai-save-my-files-default.md).
2. Share… (`PUT /api/chats/:id/audience`) shares the chat and says nothing about those files. The widening check counts
   places that answers *read*, not files the chat *made*. So the owner's share went straight to "Shared with 1 person".
3. `users/<id>/` is private by path to everyone, admins included. Per-file grants (`file_share_grants.role`, CHECK
   `('view')`) and folder shares are view only. Their reads are switched off in shared chats
   (decisions/20261116-shared-files-for-the-ai.md, 20261117-shared-chat-share-find.md Rule 4).
4. A file link in the answer opens the panel through the folder rules (`FileBody.tsx`, `fetchFileBlob`). Someone else
   gets a 404, shown as `preview.notFound`. There is no button and no way to ask.
5. Chat files (`chat_files`, migration 400) already belong to a people-shared chat. Whoever sees the chat now can open
   them. On first share the creator's computer uploads are copied in (`copied_from`). They cannot be edited in place:
   `save_chat_file` makes a copy in a team folder. Team project chats save to the project folder, which every member
   can write.

## Options

- **(a) Per-file edit grants** for the chat's people, given at share time and for each new file. This needs a write
  exception in `RuleSet` for someone else's `users/<id>/`. That breaks the oldest invariant ("users/<id>/ stays private
  by path, admins too"). Every write tool, versions, conflict copies, `make_file`'s "output next to the source" and
  moves would then put a second person's bytes into the owner's private folder. Grant reads are also off in shared
  chats on purpose. It is the largest change and the riskiest one. **No.**
- **(b) A shared folder per chat** (`chats/<title>` with rules that follow the chat's audience). It would reuse folder
  rules, but it is a second model next to chat files. Session e6 is extending chat files right now for the AI's output
  in people-shared chats (plan 20261121-0146-ai-sees-and-saves-workspace-output.md, PR2). It would also add a new top
  folder (`TOP_FOLDERS`, labels in 6 languages, Admin › Folder permissions). **No**, as agreed with the coordinator.
- **(c) Recommended: one place per kind of chat, and files come in as copies made by their owner's own press.**
  - **Chat shared with people:** the files are **chat files** (e6's model for new output), and chat files become
    **editable in place** (a new version per save).
  - **Team project chat or project room:** the files go to the **project folder**, which members already edit.
  - **Files made before sharing** (the owner's case) are **copied in** at share time, ticked in one step of the Share
    dialog. The answer's links then open the copy. The owner's original stays where it was.

Why (c): it reuses the two places that already have the right audience (the chat's viewers, the project's members). It
adds no new path into anyone's personal folder. "Who can open it" is simply "who is in the chat or project now", so
removing someone needs no extra work. It matches Gmail's "share these files?" moment without a view-only choice.

## The recommendation, in detail

### Where each file lives

| Chat kind | New files Trina makes there | Files from before (own folder) |
|---|---|---|
| Personal chat | `users/<id>/` (unchanged) | n/a |
| Shared with people | attached to the answer as a chat file (e6 PR2) | copied in as chat files at share time |
| Team project chat, project room (and its ✦ side chat) | project folder (unchanged; project room files go to `Chat attachments`, #168) | copied into the project folder at share time / when people are added |

### Which files count as "the chat's files"

Only the server's own records, never the AI's text:

- **Made here:** `file_events` rows whose `turn_id` is a turn of this chat, written by `write`, `edit`, `make_file`,
  `edit_hwp`, `stamp_pdf` and e6's `save_work_file` (`placeProduced`), with nothing relocated since. This is the same
  rule as `madeInChat` (`chat/shared-actions.ts`), extended to every turn of the chat.
- **Used here:** the answers' "참고한 파일" records (`GET …/messages/:id/sources`, via `read`).
- Of those, only files **in the pressing person's own folder that they own**. Never skills, instruction files, places
  the server keeps, `.attachments`, a project folder, a file on the download-only list, or a file over
  `CHAT_FILE_MAX` (people-shared chats; listed as "too large, share it from Files").

### Flow 1: the Share dialog asks (people-shared chat)

The step appears on **Share** only when the chat has such files that a new person cannot open. The server's existing
`confirm` answer of `PUT /api/chats/:id/audience` gains `files: [{ id, name, place, made: boolean, size }]`. The dialog
shows the step in place, like today's widening warning. The confirm key covers the listed file ids.

en:

> **Share the files from this chat too?**
> QA Member Two can't open 2 files from this chat. Add copies to the chat so everyone here can open and edit them.
> ☑ 견적서_Sincere_마케팅에이전트.pdf · My files › 견적 › Sincere · Made here
> ☑ 견적서_Sincere_마케팅에이전트.html · My files › 견적 › Sincere · Made here
> ☐ 단가표.xlsx · My files › 자료 · Used here
> Your originals stay in My files. Files Trina makes here from now on are shared with everyone in the chat.
> 1 file in Sales stays where it is. QA Member Two can't open it.
> [Share without files] **[Share with files]**

ko:

> **이 대화의 파일도 공유할까요?**
> QA Member Two 님은 이 대화의 파일 2개를 열 수 없어요. 대화에 사본을 추가하면 여기 있는 모두가 열고 고칠 수 있어요.
> ☑ 견적서_Sincere_마케팅에이전트.pdf · 내 파일 › 견적 › Sincere · 여기서 만듦
> ☐ 단가표.xlsx · 내 파일 › 자료 · 여기서 참고함
> 원본은 내 파일에 그대로 있어요. 앞으로 트리나가 여기서 만드는 파일은 대화에 있는 모두와 공유돼요.
> 영업 폴더의 파일 1개는 그대로 둬요. QA Member Two 님은 열 수 없어요.
> [파일 없이 공유] **[파일과 함께 공유]**

- "Made here" is ticked and "Used here" is not: a source file may be private for other reasons.
- After the press, the toast reads "Shared with 1 person · 2 files added to the chat" ("1명과 공유했어요 · 파일 2개를 대화에
  추가했어요") with Copy link.
- People added later get the same step only for files that are still outside the chat. A chat with nothing to offer
  shares exactly as today.

### Flow 2: new files later

- **People-shared chat:** e6 PR2 attaches the AI's output to its answer as a chat file. With S2 below, anyone in the
  chat (and their AI in this chat) can edit it, and each save is a new version. There is no card and no prompt. The
  step line reads "Added to the chat: everyone here can open and edit it".
- **Project chat or room:** unchanged. Saves go to the project folder, and the wider-audience card does not fire there
  (the readers are the members).

### Flow 3: the panel's dead end becomes Ask for access

`GET /api/chats/:id/file-access?path=` answers `open`, `ask` (with the answerer's name), `asked` (with a date) or `no`.
It answers only for paths this chat's records name (made, used, or linked in an answer). Any other path gets `no`, the
same as a file that does not exist, so the endpoint cannot be used to probe paths. It is limited to 60 calls a minute,
like `/api/link-access`. Guests get `no`.

Panel, en: "You can't open this file yet. **QA Member** made it in their own files." **[Ask for access]** → "Request
sent. You'll see the answer in Activity." For `no`: "You can't open this file. Ask the person who shared this chat."
ko: "아직 이 파일을 열 수 없어요. **QA Member** 님의 내 파일에 있어요." **[접근 요청]** → "요청을 보냈어요. 답은 활동에서
볼 수 있어요."

**Who answers:** the file's owner if they are in the chat, otherwise the chat's creator (for a project, the file's owner
if they are a member, otherwise the project's creator).

**What the answerer sees in Activity:** "QA Member Two asked to open 견적서….pdf in the chat 'Sincere 견적'."
("QA Member Two 님이 'Sincere 견적' 대화의 견적서….pdf를 열게 해 달라고 요청했어요."). The buttons depend on the case:

- **They own it:** **[Add to the chat]** / **[Add to the project]** (the same copy as Flow 1; everyone in the chat gets
  it, and the line says so) · [Decline].
- **Someone else's personal file:** [Ask <owner>]. This is the existing `FileShares.requestFor`, the request asked on
  behalf of other people (20261116-ai-share-who-can-open.md) · [Decline].
- **A team or group folder file:** [Ask an admin]. This is the existing 1:1 message to the owner and admins, and it
  changes nobody's access · [Decline].

The asker never learns which case applies. A decline reads "Your request for access wasn't approved." with no name, as
for files today.

### Flow 4: projects

- **A private chat in a team project becomes shared** (`ShareChatFlow`): same step as Flow 1. The target is the project
  folder: "Copy them to the project folder so its members can open and edit them" / "프로젝트 폴더에 사본을 넣으면
  멤버 모두가 열고 고칠 수 있어요".
- **Adding people in the project's Members dialog** (`saveParticipants`): same step. It lists only files **owned by the
  person pressing Save** that the project's chats or room side chats made or used and the new people can't open. Other
  people's files reach the new member through Flow 3.
- **Where copies go:** the project folder root (the name gets "(2)" when it is taken), through `placeProduced` as the
  presser (write access, storage, versions, file events).
- Read-only project members open the files but cannot edit them. That is the project's own rule, unchanged.

### When someone is removed

- **People-shared chat:** chat files open for whoever sees the chat now, so a removed person loses them at once (their
  turns are stopped as today). Copies they saved elsewhere with `save_chat_file` are theirs, as in Slack or Drive.
- **Project:** the folder rules change, `afterAccessChange` runs, and they lose the project folder. The room
  membership follows (#161).
- Files the removed person made stay with the chat or project.

### The owner's private folder

Nothing moves out. The originals stay in My files › 견적 › Sincere exactly as they were, and the chat's links open the
chat's copy. After the copy, the two are separate files. The toast and the step line say "Your originals stay in My
files." No grant is ever written into `users/<id>/`.

### What each person's AI can read and write

- **In the people-shared chat:** everyone's AI reads the chat files (`chat_file`, full read since #1286) and, with S2,
  edits them as new versions. It still cannot read anyone's own folder without the existing read card.
- **In their own chats:** chat files are not reachable (they belong to the chat). "Continue in a chat only you see"
  plus `save_chat_file` makes a personal copy, as today.
- **Projects:** the project folder through the folder rules, everywhere, as today.

### Guests

- A guest is never in a people-shared chat (`chat-audience.ts`), so Flows 1–3 never reach one.
- In a project, a guest who reads the project folder gets the copied files like any member. The project step counts
  guests: "2 people and 1 guest".
- A guest's `file-access` answer is `no` (no Ask button), as link-access answers 403 to guests today.

### Files the new person can't see in team or group folders

They are never copied, moved or granted by this feature. The step names them only to the person sharing, who can open
them ("1 file in Sales stays where it is"). Flow 3 turns them into [Ask an admin], which changes nothing by itself. The
folder rules stay the only way into a team folder.

### Files the owner doesn't own

The person sharing can copy only files they own (owner = the file-event creator, `creatorOf`). Someone else's file is
listed as "QA Member Three's file: they decide" and is never ticked. It reaches the chat only by its owner's own press
(Flow 3).

## What gets removed

- The bare dead end for a file a chat made or used: `preview.notFound` stays only for a file that really is gone.
- The silent share: a chat with its own files no longer shares as if those files were not there.
- Nothing becomes view only, and no per-file prompt is added after the share.

## Security notes

- **Nothing widens beyond the chat's own files.** The list comes from `file_events` of this chat's turns and the
  answers' source records. The server rebuilds it at the press and checks each id again (same sha256, still in the
  presser's own folder, still owned by them, not a refused kind). The client sends ids from the list and nothing else.
- **Only the owner of a file can share it.** At share time that is the chat's creator, for their own files. In Flow 3
  it is the file's owner, or the creator asking the owner. Team files never go through this path.
- **No new access path.** People-shared chats use chat files (the chat's viewers). Projects use folder rules. Neither
  touches `RuleSet` for `users/` or the grant tables' view-only role.
- **No probe.** `file-access` answers only for the chat's own paths, gives one body for every refusal, never says
  which folder a file is in to someone who can't open it, and is rate-limited. Requests reuse the file-request limits
  (5 a day to one owner, 20 an hour).
- **Audit:** `chat.files_added { count, via: 'share' | 'request' }` and `project.files_added`. Counts and ids only.
- **The "AI should match Claude Code" rule:** the only limits added protect one person's data from another (a file
  leaves its owner's folder only by its owner's press). After that there are no caps, no per-file cards and no view-only
  tier. Rule A (Always allow) is untouched.
- **Accepted residual:** a copy is a snapshot, so the owner's original and the chat's copy can drift. That is the price
  of never writing into a private folder, and the toast says so.

## Steps (PRs)

All of these go to `dev` in **one batch** (batch rule). Sizes are rough line counts excluding tests.

| # | PR | Size | Contents |
|---|---|---|---|
| S1 | server: share-time file step | M, ~450 | `chat/chat-files-share.ts` (new: the list, made + used, filters), the `confirm` answer gains `files` and the body gains `addFiles` in `people-share.ts putChatAudience`, `ChatFiles.copyFromTeam` in `chat/chat-files.ts` (bytes from the checked descriptor, `source_path` and `source_sha256` recorded), the answer links of a copied path open the copy for the chat's viewers, audit. Migration **432_b_chat_file_sources** (`chat_files.source_path`, `source_sha256`; additive). |
| S2 | server: chat files editable in place (**joint with e6**) | M, ~400 | `chat_files.replaces` (a version chain; the newest is "the file"); AI `write`/`edit` take a chat file by id in a people-shared chat and save a new version; `make_file`/`stamp_pdf` take one as a source and attach the output; `PUT /api/chats/:id/files/:fileId/content` with `baseSha256` (conflict = a new version beside it, as team files do). Migration **433_b_chat_file_versions**, or folded into 432 if S1 and S2 ship together. |
| S3 | server: Ask for access from a chat | M, ~350 | `GET/POST /api/chats/:id/file-access`, answerer routing, Activity actions (add to chat / project, ask owner, ask an admin, decline), push through the existing `access.requested`. Migration **365_c_file_request_chat** (`file_access_requests.chat_id`, `project_id`; additive; an older build approves such a request as a view grant to the asker only, which is narrower). |
| S4 | server: projects | S–M, ~250 | the same list and copy for `ShareChatFlow` (private → shared project chat) and `saveParticipants` (Members dialog), copy into the project folder through `placeProduced`. |
| W1 | web: the Share step | M, ~400 | `ChatShareDialog.tsx`, `ShareChatFlow`, `ProjectMembersDialog.tsx`, toast, i18n in all 6 languages (en, ko, es, id, ja, zh). |
| W2 | web: panel and versions | S–M, ~300 | `FileBody.tsx` / `FilePanel.tsx` Ask state, Activity rows, the chat file chip's "Updated by X" line and version list. |

Order: e6 PR1 → e6 PR2 → S1 → S2 (with e6) → S3 → S4 → W1 → W2, then one batch PR.

### Migrations (highest on dev f2cc8ed5c: B 431, C 364, overall 702)

- `432_b_chat_file_sources.sql`, `433_b_chat_file_versions.sql` (component B range 400–499).
- `365_c_file_request_chat.sql` (component C).
- All are additive (reader 1). Check `server/migrations/` on `dev` again right before each PR, in case e6 or another
  branch takes 432 first.

### Overlap with work in flight

- **e6 (`fix/ai-sees-and-saves-workspace-output`)**: both touch `server/src/chat/chat-files.ts` (S1, S2),
  `server/src/chat/chat-file-tool.ts` (S2), `server/src/chat/turn.ts` (S2: write targets) and
  `web/src/components/chat/Messages.tsx` (W2: chips, link to the copy), and S2 adds to the `rooms/ai-tools.ts` tool
  lists. S2 is a joint item: chat files must be editable in place, or the owner's "no view only" fails for every file
  e6 attaches. **e6 merges first; this work rebases on it.**
- **#47 `batch/1119-raka` (open)**: touches `server/src/chat/shared.ts`, `prompt.ts`, `shared/src/api/entities.ts`,
  `web/src/lib/sharedChat.ts` and `web/test/unit/chat-share-dialog.test.tsx`. S1 and W1 touch `entities.ts` (the
  confirm schema), `ChatShareDialog.tsx` and that test. These are small textual conflicts; rebase after #47.
- **Project room 1–4 (#158, #161, #168, #167) and #190**: all merged into dev, and `origin/batch/20261121-project-room`
  has nothing beyond dev. S4 builds on them: room files already go to `Chat attachments`, and the side chat saves to
  the project folder (`side-room.ts savePlaceFor`). W1 edits `ProjectMembersDialog.tsx`, which #190 just changed.
- **#192 (open, ko wording 대화방)**: `web/src/i18n/ko.ts` and `server/src/chat/i18n.ts`. W1 uses "대화방" for the
  project room per #192.

## Decisions

A new `docs/decisions/20261121-share-chat-files.md` with S1. It supersedes nothing. It adds to "Chats shared with people
and groups" (DECISIONS.md), 20261116-shared-files-for-the-ai.md and 20261118-chat-files-full-read-and-save.md (chat
files gain versions).

## Open questions (one recommendation each)

1. **Copy or edit grant for files from before the share?** Recommend **copy**. A grant would put other people's writes
   into a private folder (option a).
2. **Offer "used" files, not only "made" ones?** Recommend **yes, listed but not ticked**.
3. **A file whose owner is outside the chat:** they still answer with today's view-only grant (`requestFor`). Recommend
   **keep it for now**. Edit for them needs option (a). Revisit if the owner hits it.
4. **What a chat file's chip opens after edits:** recommend **the newest version**, with "Updated by X · time" and the
   older versions in the panel's version list.
5. **Where copies land in a project:** recommend **the project folder root**. `Chat attachments` stays for room uploads.
6. **Files over 50 MB (`CHAT_FILE_MAX`) in a people-shared chat:** recommend **list them as "too large" with a link to
   the file's own Share…** (a view-only grant). Otherwise suggest moving the chat into a project.
7. **Unsharing a chat (everyone removed):** recommend **the chat files stay with the chat** (its creator still sees
   them), as today for uploads.

## Risks

- S2 changes chat files from immutable to versioned. The bytes checks (`sha256`), `chatFileCopyOf` and e6's attach path
  must all read "the newest of the chain". Security review required (Opus).
- Copies count toward team storage.
- Older apps show the old dead-end line (the new fields are optional).

## Tests

`bun run typecheck`, `check:prepush`, `check:i18n`, `check:docs`. Unit tests: `tests/unit/b-share-chat-files.test.ts`
(made/used list, owner-only, refused kinds, re-check at press, links open the copy, removal),
`b-chat-file-versions.test.ts`, `c-chat-file-access.test.ts` (no probe, one body, limits, guest), and
`b-project-share-files.test.ts`, plus `tests/security`. Web: `chat-share-dialog.test.tsx`, a new
`web/test/e2e/share-chat-files.spec.ts` at 1440 and 390 in light and dark, and the owner's case end to end on a QA copy.

## Screenshots of today

Taken on a QA copy (port 19961, scripted AI, deleted after), not committed: the owner's chat with two files made in My
files; the Share dialog with no file step; "Shared with 1 person" with no word about the files; the other person's
panel showing "The file can't be found, or you don't have access to it."

## Result

(filled in at the end)
