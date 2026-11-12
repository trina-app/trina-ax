# Getting back to earlier work, part A: one set of marks, rows that say when

- Date (UTC): 2026-11-12 16:21
- Branch: `feat/history-way-back-a`
- Status: in progress
- Where: Team AX core (`web/src/components/SearchDialog.tsx`, `web/src/lib/sessionMarkers.ts`,
  `web/src/components/chat/ChatTitleMenu.tsx`, `web/src/pages/Files.tsx`, `server/src/routes/files.ts`, a small
  helper in `server/src/chat/`, `shared/src/api`). Why: chats, search and file history are core.
- Version impact: minor (an additive, optional field on the file history answer).

## Goal

The owner (2026-11-12): it is hard to get back to earlier work; the AI history is the only way back. Option A of the
session research is part of every option, so it comes first. QA TC-419 to TC-423.

## Scope

In:
1. TC-419 (bug): ⌘K "Needs attention" shows the sidebar's own session markers ("?", the ring, the dot) and their words
   (`marker.*`), from the same list and the same rule (`markerOf`). A finished answer not seen yet is there too. ⌘K's
   own "Answering now" / "Waiting to answer" go.
2. TC-420: ⌘K History rows (the list and search results) show, in grey on the right, when the chat was last active
   ("2 hours ago", `formatRelative`, as the project page and the sidebar's peek) and its project's name.
3. TC-421: ⌘K opened on a project's page or in a chat that is in a project: History lists that project's chats first
   (the project page's own list), then the rest. Anywhere else nothing changes. No new control.
4. TC-422: the chat's title menu gets "Pin to top" / "Unpin", the row menu's item, icon and call.
5. TC-423 (security): a file's version history links an AI-saved version to **Open the chat**, only when the viewer
   may open that chat now. `GET /api/files/history` adds the chat's id to such a version (`savedChatId`) and to
   `current` (`chatId`) only then: `chatFor` 'view' (not in the trash), not someone else's confidential chat, not an
   answer of a shared chat that is hidden from the viewer. No migration: `turns.chat_id` already holds the chat.

Out: Home's "Continue" line, automatic summaries, AI search of chats, any sidebar change (owner 2026-11-06/07), the
⌘K row menu, Recents rows.

## Steps

1. `lib/sessionMarkers.ts`: `markedChats()` (the chats with a marker, "?" first, then new answers, then running).
2. `SearchDialog.tsx`: attention from the chat store with that helper and `SessionMarker`; History rows' time and
   project on the right; project-first History from the route.
3. `ChatTitleMenu.tsx` + `pages/Chat.tsx`: the pin item.
4. Server: `server/src/chat/version-chats.ts` (turn ids to the chats the viewer may open), used by the history route;
   `shared/src/api` fields; `pages/Files.tsx` link.
5. i18n (5 languages), DECISIONS entry, `changes/history-way-back-a.md`.

## Risks

- TC-423 must never reveal a chat: someone else's private chat, one in the trash or purged, a shared chat the viewer
  lost, a confidential chat that is not theirs, a chat in a project they cannot see, a room's AI. Security tests for
  each in `tests/security`.
- ⌘K reads the same chat list as the sidebar: no new request for the marks.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`; unit: session markers, search, chats, pins, file history; security:
the new version-chat test; `test:web`, `build:web`; e2e: search palette, chat pins, files/versions.

## Result

(filled in at the end)
