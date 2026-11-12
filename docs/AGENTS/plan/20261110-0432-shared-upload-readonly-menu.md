# A shared chat's box offers the computer only to people who may write the project folder

- Date (UTC): 2026-11-10 04:32
- Branch: `fix/shared-upload-readonly-menu`
- Status: done
- Where: trina-ax core (`server/src/uploads/shared-chat.ts`, `server/src/chat/`, `shared/src/api/entities.ts`,
  `web/src/components/chat/`). Why: chat, files and permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Two optional fields and a box that hides what would be refused; no migration.

## Goal

Since #296 a file from the computer in a shared project chat goes into the project's chat attachments folder. Someone
who can only read the project folder still sees "내 컴퓨터에서 올리기" (and can paste or drop a file), and only gets the
refusal (403 `shared_upload_read_only`) after picking one. The box should not offer what will be refused.

## Scope

In:
- `Project.chatUploads` (a project that shares its chats: may the caller's computer files go into its new chats) and
  `Chat.shared.canUpload` (the same in a shared chat), both optional, computed with the upload's own check
  (`sharedUploadPlace`, as a yes/no), once per project per request.
- The box: when false, no "내 컴퓨터에서 올리기" and no camera ("팀 파일에서 추가" stays); pasted files are ignored (pasted
  text still goes in); files dragged from the computer get the not-allowed cursor and no highlight, and a drop does
  nothing (the browser does not open the file); a team file dragged from the file screen still drops. Missing (an
  older server): allowed, as today.
- The 403 stays as the fallback (access changed while the box was open). The e2e mock follows.

Out: any change to who may write; personal projects and chats of one person (unchanged).

## Steps

1. `mayUploadShared` (shared-chat.ts): `sharedUploadPlace` without the throw; memo per request in `Audiences`.
2. The two fields: `routes/chats.ts` (projects), `chat/shared.ts sharedOf` (chats).
3. Web: `Composer`, `ComposerFiles` (`useComposerFiles`, `useFileDrop`), `NewChatComposer`, `pages/Chat.tsx`.
4. Tests: server (a reader and a writer), web unit; DECISIONS, CHANGELOG, API docs.

## Risks

Cost: the check reads the rules and the project folder once per project per request (chat lists). Security: the
fields only say what the 403 would say; the server still decides at upload.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; `tests/unit/b-shared-chat-uploads.test.ts`; web unit in
Docker; the shared-chat e2e spec.

## Result

Built as planned. `sharedUploadPlace` now takes the database and any files layer with the same rules (`UploadFiles`), so
the chat code can ask it; `Audiences.mayUpload` keeps one answer per project and person of a request. A team file
dragged from the file screen still drops where the computer's files are not taken. `feat/room-drop-anywhere` was not
on the remote when this was pushed, so there was no overlap to resolve in `useFileDrop` (its new `files` option is
optional; the side chat's call is unchanged). PR: https://github.com/trina-app/trina-ax/pull/301.
