# delete_files: the AI moves files to the team trash behind a server card

- Date (UTC): 2026-11-09 19:05
- Branch: `feat/ai-delete-files`
- Status: done
- Where: trina-ax core (`server/src/team-files/`, `server/src/chat/`, `shared/src/`). Why: files, permissions and the
  chat's tools are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new AI tool and a new card; no API, setting or data change.

## Goal

Asked "다운로드 폴더 임시 파일 지워줘", the AI answers "죄송하지만 파일을 삭제할 수 없어요": it has no delete tool
(docs/DECISIONS.md "파일 도구" deferred it). The person must open the Files screen. After this the AI can move files and
folders to the team trash, exactly like the Files screen's delete, after the person says yes on a server card that
shows exactly what goes and who loses it. Nothing is deleted for good; the trash restores it until its purge date.

## Scope

In:
- `delete_files(paths[])` in the person's own chat only. It calls `TeamFiles.remove`, never `FileService.deleteFile`.
- Never, for any role (admins and the owner included): top-level folders; group, project and rule folders
  (`managedInside`) and any folder that holds one; skill roots (`skills/`, `groups/*/skills`, `projects/*/skills`,
  `users/*/skills`), the folders that hold them and anything in them; `users/<someone else>`; `.system`; plugin
  folders; `.attachments`; share-link targets.
- At most 200 entries per call, counted inside folders by a walk that stops at the cap.
- A manifest per call (path, dev, inode, size, mtime of every entry; who can read and write each item; the trash
  retention days), checked again inside `remove()` around `moveIntoTrash`: a folder is moved first, checked, and moved
  back when it changed.
- A skill guard in `remove()` itself for AI turns, fail-closed.
- The card: full paths, files per folder, the other people whose files these are (as file history shows them), how
  many people lose it and how many of them cannot restore it, the purge date from the setting, that admins can empty
  the trash early. Five languages.
- At most 2 delete cards per answer, none after a "no", one destructive card open at a time; never a room grant,
  "always allow" or an earlier yes.
- One audit row per call (`files.ai_trash`) with the card id, the turn id and the trash ids.
- The prompt says what the tool does and that it is for when the person asks to delete.

Out: rooms, shared chats and other people's words (refused, not offered); skill folders (a later PR); restore by the AI.

## Steps

1. `TeamFiles.planAiTrash` (checks, walk, manifest, card facts) and `TeamFiles.trashAiPlan` (one synchronous block:
   check every item again, then `remove()` with the manifest). `remove()` gets the AI checks.
2. `server/src/chat/delete-files.ts`: the tool, its mode refusals, the card, the per-answer limits, the audit row.
   Offered in `buildToolSet`; listed in `PARENT_ONLY_TOOLS`; never in `FILE_TOOLS`, `ROOM_TOOLS` or `SHARED_TOOLS`.
3. Step label, prompt lines, web audit label, docs (DECISIONS, PERMISSIONS, CHANGELOG).
4. Tests for every rule above.

## Risks

- Security: a prompt-injected deletion. The card shows exactly what runs; the yes is bound to the manifest; nothing
  answers the card but the person who started the turn; no grant covers it.
- A parallel `move_files` into a listed folder after the card, or a dev-environment job writing there: the manifest.
- No migration (highest on dev: 701). Five app languages. No web component change (the card uses `details`).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, the file, chat and room suites,
the security permission matrix, the whole `tests/unit` suite (failures compared with dev), web unit tests in Docker.

## Result

Built as planned (docs/DECISIONS.md "AI가 휴지통으로 옮기기"). Differences, each the safer option:
- One refused path refuses the whole call before any card; hidden items, instruction files and project folders
  (personal ones too) are refused as well; a chat holding room messages or asked from Slack is refused up front; no
  answer counts as no; not offered in approved template runs.
- After an independent review: while a delete card is open, any other card of the answer waits behind it
  (`waitForPerson` `exclusive`); the list on the card is never folded; every call writes its audit row; once an item
  is in the trash, a failing follow-up does not turn it into "not moved".
- `fix/ai-skill-move-like-page` landed meanwhile and was merged in (no overlap in behaviour); `fix/ai-refusals-clear`
  had not, so the refusals carry their own reason and next step.
- No web component change (the card uses `details`): only the audit screen's label, in five languages.
- PR: https://github.com/trina-app/trina-ax/pull/277
