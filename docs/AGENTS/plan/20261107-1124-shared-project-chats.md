# Shared project chats, phase 1: a project's people see and continue its new chats

- Date (UTC): 2026-11-07 11:24
- Branch: `feat/shared-project-chats`
- Status: in progress
- Where: Team AX core (`server/src/chat`, `server/src/routes/chats.ts`, `shared/src/api`, `web/src`). Why: chats,
  projects and permissions are core (see docs/REPOSITORY-RULES.md).
- Version impact: minor. A new feature with optional API fields (`Project.shareChats`, `Project.audience`,
  `Project.sharedChats`, `Chat.shared`) and an add-only migration.

## Goal

A project editor turns on "이 프로젝트의 채팅을 프로젝트 사람들과 공유". From then on, every new chat in that project can be
seen and continued by the people who can read the project folder (owner and admins included). Each turn runs as the
person who sent it: their access, AI connection, engine, budget, queue and usage. Nothing anyone else cannot open
enters the shared transcript without the sender's yes on a card.

Owner decisions: turning the setting off keeps existing shared chats shared (D1); no "나만 보기" per chat (D2);
attachments in shared chats are team files only, computer uploads are refused (D3).

## Scope

In:

- Migration `265_b_shared_project_chats.sql` (add-only, `min_compatible_reader: 1`): `projects.share_chats`,
  `chats.shared_at`, `turns.shared_checked`, two partial indexes. 263 is on dev and 264 is on another open branch.
- Visibility: `shared_at` set, the project exists and the viewer can see it (`canSeeProject`). Personal projects never
  share (409 `project_personal`). Confidential chats are never shared; while safe operations (1A) are on, shared chats
  are read-only (409 `safe_ops`) and the setting is refused. `markConfidentialTurn` refuses a shared chat.
- `ChatStore.ownChat` is replaced by `chatFor(viewer, id, 'view' | 'continue' | 'manage')` in every chat route, the
  artifacts, team-file attachments and uploads. Busy: 409 `shared_chat_busy`. Stop and cards: the runner only. Rename
  and engine: the creator. Delete and restore: the creator or a project editor. Edit and regenerate: own messages only.
  A shared chat cannot change project (409).
- Turns: `SHARED_TOOLS` (`ROOM_TOOLS` without the room tools). No browser, box, connections, Drive, memories or
  `room_read`. A "Shared chat" prompt block, other people's messages taint the session, the URL gate counts only links
  the runner typed. Folder lists, skills, team rules and the company profile are filtered to what the whole audience
  reads.
- The read gate (`confirmSharedRead`): before any read whose sources some of the audience cannot read
  (`missingReaders`), the runner gets the card "읽고 공유하기 / 읽지 않기". No, a timeout or a scheduled run is a refusal
  that names no path. File tools, searches (every readable rule folder under the start; no path = the project folder),
  skills, "/name", attachments and sub-agents.
- Engine memory: resume only a stash the runner's own turn wrote; otherwise a fresh session with the labelled
  transcript (40,000 characters at most). The per-chat engine folder is cleared when the person changes; if that
  fails, the turn does not start. `resetEngineSessions` also resets the person's stashes in other people's chats.
- Per-viewer views: step labels and the file summary name a path only for viewers who can see it; usage, errors,
  live text and cards stay with the runner. `chat.updated` goes to the audience; deltas and cards to the runner.
- Rollback guard: this build sets `turns.shared_checked`; at start a chat with an unchecked turn after `shared_at`
  stops being shared.
- Deleting a project purges its shared chats; a purged account's shared chats stay under the tombstone name.
- Audit: `project.share_chats`, `chat.shared_read` (decision and counts, no names), `chat.delete` by a non-creator.
- Web: the project setting and hints, the project page "채팅" section with the shared icon and the creator's name,
  shared chats I wrote in in the sidebar, the new-chat line, the composer footer line, the header icon, the author
  above other people's messages, the queue and card-waiting lines, the refusals, the counts in the delete and repoint
  dialogs, the phone layout. Five languages.

Out (phase 2): live answers for viewers, unseen markers per viewer, a chat file store for uploads, connections and
Drive behind the gate, share-to-room for every viewer, a gate that checks searches after they run. Not added at all:
a toggle per chat, sharing existing chats, avatars, deleting single messages, a people picker, push or Inbox notices,
a "Shared" sidebar section, queued sends.

## Steps

1. Migration, API fields, `chat/shared.ts` (audience, `chatFor`, per-viewer views), routes.
2. Turn: tool set, prompt, read gate, engine memory and folder clearing, URL gate, events.
3. Rollback guard, project delete, account purge, export, `resetEngineSessions`.
4. Web UI and strings in ko, en, id, ja, es; ui-polish pass at 1440 and 390, light and dark.
5. Tests: unit (setting, creation, lists and search, access lost or gained, busy, runner usage, delete / move /
   repoint, card yes / no / timeout across files, own folder, search, skills, attachments and sub-agents, allowlist,
   resume and folder clearing, stash reset, per-viewer views, rollback guard), `tests/security/shared-project-chats.test.ts`,
   rows in `permission-matrix`, `p4-route-coverage`, `safe-ops-matrix`, `web/test/e2e/shared-project-chats.spec.ts`.
6. Docs: DECISIONS, PERMISSIONS, the user guide, CHANGELOG, `docs:api`.

## Risks

- Leaks through a shared transcript (content, a file's existence, a person's identity). Covered by the gate, the
  per-viewer views and two independent reviews.
- Engine sessions carrying one person's reads into another person's turn: never resumed across people, the folder is
  cleared, fail closed.
- Rollback to an older build that runs ungated turns: the guard unshares such chats on the way forward.
- Migration number collisions with other open branches: checked against `origin/dev` before the PR.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, the unit tests of the touched
areas, the security suite, `bun run test:web`, `bun run build:web`, the full web e2e, and a real-engine run.

## Result

Filled in at the end.
