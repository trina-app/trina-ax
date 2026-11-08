# Share an existing private chat with the project's people

- Date (UTC): 2026-11-08 01:37
- Branch: `feat/share-existing-chat`
- Status: done
- Where: trina-ax `server/src/chat` (share-chat.ts new, answer-share.ts, shared.ts, store.ts), `shared/src/api/chats.ts`,
  `web/src/components/chat` (ChatProject.tsx, ChatTitleMenu.tsx, ShareChat.tsx new). Why: chat sharing and permissions
  are Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor (a new endpoint and an audit action; no migration).

## Goal

The owner: "공유 프로젝트로 옮겨도 그 채팅은 계속 나만 봐요 -> 왜? 그럼 이거 공개로 바꿀 수 없어?" Shared project chats
(#171) share only chats made while the setting is on. The creator of a private chat in a sharing project (also one just
moved there) can now share it, after a one-time check of what the chat contains: its earlier turns had no read card,
so the visible answers may carry content from places narrower than the project's audience.

## Scope

In:
- `POST /api/chats/:id/share` `{confirmKey?}`. The creator only; a team project with `shareChats` on that they see.
  409 with a reason for: no such project / setting off, a personal project, safe operations or a confidential chat,
  already shared, a scheduled run's chat, a project in the trash, a busy chat.
- The check over every branch: every answer's `message_sources` (with sha256), the session read scope (when it
  describes every answer; else "unknown"), personal memories when they were loaded. Reuses #163's provenance code
  (`missingReaders`, the hash rule, places named only where the creator may look) — refactored into one function both
  use, not a second copy. Nothing left: shared at once. Else `confirm` with the provenance line, a memory note, and an
  opaque `confirmKey` (HMAC over the audience, sources, memories and every message of every branch). Same budget as #163.
- Sharing: `chats.shared_at = now`; the chat's engine session is forgotten (the creator's private session holds
  memories and tool results the transcript does not); the earlier turns are marked `shared_checked` (the rollback guard
  has no time filter and a turn from before migration 265 would unshare it); audit `chat.share` (counts, confirmed).
- Per viewer: steps of answers from before sharing show the words alone to everyone but the person whose turn it was
  (their labels can name paths, URLs, a remembered text; old steps have no per-viewer copy).
- UI: the move dialog's switch "프로젝트 사람들과 공유" (default off) when the chosen project shares chats; the title
  menu's "프로젝트 사람들과 공유…" for a private chat already in such a project; one confirm dialog (#163's provenance line
  style); toast "프로젝트 사람들과 공유했어요". Five languages.
- Mock server, unit, security and e2e tests; DECISIONS, PERMISSIONS, CHANGELOG, API docs.

Out: unsharing (D1: shared stays shared); row menus and `Projects.tsx` (another branch).

## Steps

1. Refactor answer-share.ts: the provenance core (`provenanceChecker`) and `BranchUse` exported; behaviour unchanged.
2. `chat/share-chat.ts`: refusals, `chatUse` (all branches), memories, key, share, audit. Route + contract.
3. Store: old steps masked for other viewers.
4. Web: `ShareChat.tsx` (confirm dialog + hook), move dialog switch, title menu item; i18n.
5. Mock server endpoint; tests; docs.

## Risks

- No migration. The share check must not become a free probe: budget, counts only, places only where the creator
  may look, no names.
- A turn starting between the check and the update: the update re-checks busy synchronously.
- The resumed private session (memories in its instructions): forgotten at share time.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`; unit tests (chat, shared,
answer-share, read-scope, projects); security suite (`permission-matrix`, `p4-route-coverage`,
`shared-project-chats`); `bun run test:web`; full web e2e; a ui-polish pass at 1440 and 390, light and dark.

## Result

Built as planned: `POST /api/chats/:id/share` (`server/src/chat/share-chat.ts`) with the check over every branch through
one provenance function shared with "대화방에 보내기" (`answer-share.ts provenanceChecker`), the key, the share (engine
session forgotten, earlier turns marked checked, audit `chat.share`), earlier steps as words alone for other viewers;
the move dialog's switch, the title menu item and one confirm dialog (`web/src/components/chat/ShareChat.tsx`).

Differs from the plan:
- `share_hidden` (409) joined the refusals: a member who would see a room the chat read but for old answers hidden from
  them is never shown it, as `answer_share_hidden` in "대화방에 보내기".
- The state checked (project, its people, every message) is read again synchronously right before the update; a change
  during the check is checked again.
- `Sidebar.tsx` changed after #182 merged: a row's move dialog now lives in the sidebar, not the row, because a moved
  chat's row moves to another group and was made again, which lost the share's confirm.
- The move's own toast shows only when the chat ends up not shared (on a phone it covered the confirm).
- `ShareToRoom.tsx` exports `placeName` (the confirm names places the same way).
- From the independent security review: answers that ran dev environment commands are "not all known" (also for
  "대화방에 보내기"); the title menu asks first (`ask`); turns from before the share are marked `shared_checked = 2` and
  the scope's order is rowid (no clock); earlier steps lose a connection's tool name; the memory note counts with nobody
  else in the project.
