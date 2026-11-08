# Project page: the faces of the people who wrote in each shared chat

- Date (UTC): 2026-11-08 05:31
- Branch: `feat/project-chat-faces`
- Status: in progress
- Where: trina-ax core (`server/src/chat/shared.ts`, `server/src/routes/chats.ts`, `shared/src/api/entities.ts`,
  `web/src/pages/Projects.tsx`, `web/src/components/chat/SharedChat.tsx`). Why: shared project chats are core chat
  (see docs/REPOSITORY-RULES.md); the people directory, `Avatar` and the shared tooltip are already there.
- Version impact: minor. A visible change on the project page and two optional API fields; no migration.

## Goal

On a project page the "채팅" list shows a shared chat as the people icon, the title and "Mina · 1분 전". The owner asked
for profile pictures there, or the faces of whoever worked in the chat, overlapping. Each shared row now shows a small
stack of the faces of the people who wrote in that chat, so you see at a glance who is in it.

## Scope

In:
- `Chat.shared.people` (optional, up to 3 `UserRef`, most recent writer first) and `Chat.shared.peopleCount`
  (optional, everyone who sent a question there, creator included), computed by the server only for
  `GET /api/chats?projectId=` (not the trash) and only for the shared chats it lists (the list's own "I see its
  project now" filter, the same as `chatFor` 'view'). One grouped query for the whole page over the
  `messages_author_chat` index (migration 265), names from `users` in the same query: no query per chat.
- The row: an overlapping stack of `Avatar`s (20 px, the people directory's photos, the letter tile without one), at
  most 3 then a "+N" chip, then "· 1분 전". At phone width at most 2 then "+N"; the title truncates first.
- One person (or nobody yet: the creator): that face and the name, `(M) Mina · 1분 전`.
- On hover over the faces, or keyboard focus on the row, the shared tooltip (#122) lists the names ("Mina, Sam, Jun
  외 2명"). The faces are `aria-hidden`; the row reads "Mina, Sam 참여" (one person: the name). Five languages.
- The shared `Tooltip` gets one optional prop, `focusFrom`: the element around it that takes the keyboard focus for it
  (the row's link). Nothing else in it changes.
- Private chats in the project: unchanged, no face.
- The people icon on the left stays; whether it is still needed is a question for the owner, with before and after
  screenshots.

Out: faces in the sidebar's chat list or the chat header; live updates of the faces while the page is open (the page
reads the list once, as now).

## Steps

1. `shared/src/api/entities.ts`: the two optional fields; `bun run docs:api`.
2. `chat/shared.ts`: `chatPeople(db, chatIds)`; `routes/chats.ts` passes it to the project list's chats.
3. Mock (`web/test/mock/server.ts`): the same fields for `?projectId=`.
4. `SharedChat.tsx`: `ChatPeople`; `Projects.tsx`: `ProjectChatRow` with it; `Tooltip.tsx`: `focusFrom`.
5. Tests: server unit (order, cap, count, only visible chats, one query and its index), web unit (1, 2, 3 and 5
   people, tooltip names, the label), e2e (two authors at 1440 and 390, axe).
6. ui-polish pass, light and dark, 1440 and 390; CHANGELOG; docs/DECISIONS.md "Shared project chats".

## Risks

No migration. No new disclosure: the people are the authors the viewer already sees in each chat, and only for chats
they may view. Speed: one query per list page (seeks on `messages_author_chat` per person and chat), checked by its
query plan in a test. Phone: the stack must not push the title out. The tooltip change touches a shared component: the
full web e2e runs once.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` and `tests/unit/docs-site.test.ts`,
the chat, shared and project unit tests, `bun run test:web`, `bun run build:web`, the project-page,
shared-project-chats and project-list-menu specs, and the full web e2e once (shared `Tooltip`).

## Result

Filled in at the end.
