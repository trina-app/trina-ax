# Projects panel: a project row opens its chats in place, with a mention count

- Date (UTC): 2026-11-20 07:53
- Branch: `feat/project-chat-accordion`
- Status: done
- Where: web (`web/src/components/panels/ProjectsPanel.tsx`). Why: a UI change of the web app's 프로젝트 panel only
  (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new visible feature of the 프로젝트 panel, no API change

## Goal

The 프로젝트 panel lists projects, but to see a project's chats you must open its page. People asked to see a project's
chat history straight from the list, and to see at a glance where somebody mentioned them. A project row gets a fold
(▸/▾) that opens its chats under it, and a small round count ("1", "2") on the project and on the chat where unread
mentions of me wait, with who mentioned me on hover.

## Scope

In: a fold button on each project row (not a trashed project, not a guest without AI); its chats under it (the
project's chats I can open, newest first, at most 8, "더 보기" opens the project page); the mention count from my
unread Inbox notices `chat.thread_reply` with `chatThread.mention`; the five app languages.
Out: room (channel) mentions; a server endpoint for counts (the Inbox's first 100 notices are read on the client).

## Steps

1. `store/chatMentions.ts`: unread chat-thread mentions by chat (count, who), read again when the Inbox changes; the
   project of a mentioned chat from the chats store or GET /api/chats/:id.
2. ProjectsPanel: fold state per project (kept in session), the chat rows under an open project, the count bubble.
3. i18n keys, unit test for the grouping, e2e screenshot by hand.

## Decisions

docs/decisions/20261120-project-chat-accordion.md. It changes the note on top of ProjectsPanel.tsx ("No chats in this
list") from docs/DECISIONS.md "Projects: a place of their own".

## Risks

No migration, no permission change: the chats come from the same GET /api/chats?projectId the project page reads, so
nobody sees a chat they could not open there.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the web unit tests for the new store.

## Result

Built as planned: the ▸ in the section's indent (a phone: a 40 px button left of the icon), at most 8 chats under an
open project (a chat with mentions first, in bold), "All chats" for the rest, and the round count (CountPill) on the
project and the chat, with who mentioned me on hover. Fold kept as `project:<id>` in the lists' folds. Tests:
web/test/unit/chat-mentions.test.ts, web/test/e2e/project-chat-accordion.spec.ts (computer and phone).
