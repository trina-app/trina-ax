# A file from the computer in a shared project chat goes into the project folder

- Date (UTC): 2026-11-10 02:01
- Branch: `feat/shared-chat-uploads`
- Status: done
- Where: trina-ax core (`server/src/uploads/`, `server/src/team-files/`, `shared/src/`, `web/src/components/chat/`).
  Why: chat, files and permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A refusal becomes a feature and one endpoint is added; no migration, no data change.

## Goal

In a shared project chat (and the new-chat box of a project that shares its chats) a file from the computer (📎,
paste, drop) is refused: "Only team files can be attached to a shared chat. Upload a file from your computer to the
project folder first, then attach it." (docs/DECISIONS.md "Shared project chats", D3). The owner: "야 왜 내 파일을
못올려? 너무 불편한데?". The reason for D3 is real: an upload normally lands in the person's own attachments folder,
which the chat's other people cannot read. The fix is to put the file where they can: the project folder, in one step.

## Scope

In:
- A computer upload into a shared chat (small and chunked) is placed in `<project folder>/채팅 첨부/` (named in the
  team's language: `CHAT_FILES_FOLDER` next to `TEMPLATES_FOLDER` in `shared/src/folder-labels.ts`; an existing folder
  under any language's name, NFC and any letter case, is reused, as for the templates folder) and attached as a team
  file (a reference, `source: 'team'`). The folder is made when missing, through the file layer.
- Names: the file's own name; a name that is taken gets the duplicates rule (`freeName`: "견적 (2).pdf"), never an
  overwrite. An instruction-file name (CLAUDE.md, AGENTS.md, GEMINI.md, SKILL.md) is treated as taken, so it is saved as
  "CLAUDE (2).md" and is never an instruction file. The folder is never a skill folder (refused if it were).
- Permissions: the uploader needs write access there (the folder, or the project folder to make it). Without it a
  clear refusal (errors table, five languages): why, and what to do instead, naming nobody.
- The same limits (50 MB per request, chunked above it, the session limits, the storage limits, at most 20 per message,
  the reference limits), the same checks (the name rules, the storage check, sha256, the safety check's download-only
  list) and the same records: the team-file `upload` event by the person (with the attachment id and the chat), text
  extraction, the live file-list change, and the `file.attach` audit of the reference. Refused while safe operations
  are on (shared chats are read-only then).
- Removing the chip before sending: `DELETE /api/attachments/:id` moves the file to the team trash (the norm for team
  files: restorable from Files > Trash), only when it is that person's upload into this chat, never sent, still in its
  place and unchanged; otherwise only the draft reference goes.
- The box: the attach menu offers the computer again in shared chats; the old note and red refusal go; one short line
  under the chips while a file from the computer is attached: "프로젝트 폴더(채팅 첨부)에 저장돼요 · 프로젝트 사람 3명이
  볼 수 있어요" (the app's wording "프로젝트 사람 {n}명", as the line under the box).
- The send guard for an upload that is not a team file stays (a chip from before the chat was shared), with words that
  say what to do.
- DECISIONS ("Shared project chats"), CHANGELOG, the API reference, the e2e mock.

Out:
- Personal projects: never shared, nothing changes. Private chats: uploads stay in the person's attachments folder.
- A chip never sent nor removed leaves its file in the folder (it is a normal team file by then).

## Steps

1. `CHAT_FILES_FOLDER` (shared); `placeUpload` takes names to treat as taken; `TeamFileRefs.create` takes the id and
   checks its limits before anything is placed; `TeamFileRefs.discard`.
2. `server/src/uploads/shared-chat.ts`: the folder and the write check; `Attachments.create` and the session check
   send a shared chat's upload there.
3. API `discardAttachment`; texts in five languages; the old refusal text removed.
4. Web: `Composer`, `ComposerFiles`, `NewChatComposer`, `pages/Chat.tsx`, `lib/sharedChat.ts`; the e2e mock.
5. Tests, DECISIONS, CHANGELOG, `docs:api`.

## Risks

- No migration (the upload is recognised by its own file event). Permissions: every write goes through `authorize`
  for the person, as a Files-screen upload. A project folder in the trash is never made again (the project folder must
  be there). Security matrix: the new route.
- Five languages for every text; phone and computer boxes share the component.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; a new `tests/unit/b-shared-chat-uploads.test.ts` (lands in
the folder, a member without write, instruction names, a name clash, removing the chip, chunked); the uploads, chats,
shared-chat and file suites and the security permission matrix; the whole `tests/unit` against dev; web unit tests in
Docker (the line, the refusal gone); the project and shared-chat e2e specs.

## Result

Built as planned. Beyond the plan: the chip shows the name the file got in the folder ("견적 (2).pdf"); the reference
takes the upload's checked hash for the placed inode (a large file is not read again); a chunked upload is refused at
its start for the reference limits and the download-only list too. The independent review found no must-fix; its
should-fix items are in: ✕ leaves a file another reference points to, a chip taken out while its file was still being
placed is taken out by the session's cancel (or by the server for a dropped small upload), no second read of the file.
Left: someone who only reads the project folder is still offered "내 컴퓨터에서 올리기" and gets the refusal. The
send guard's refusal (an upload of the person's own folder from before the chat was shared) has new words. PR:
https://github.com/trina-app/trina-ax/pull/296.
