# A continuation keeps its place under its chat through live updates

- Date (UTC): 2026-11-27 17:06
- Branch: `fix/fork-parents-live-updates`
- Status: done
- Where: server/src/chat, server/src/routes/chats.ts, shared/src/api, web/src/store, web/src/lib/forkTree.ts. Why: the
  chat list and its live events (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no new feature or API (an event field that was missing is now sent; a query the
  contract already refused in words is now refused with 400)

## Goal

QA on qa.trina.app (dev with batch #699): after any live update of a continuation (a message sent, a rename with "···",
the same from another tab or device, a new continuation heard live), its row jumped to the top of the history as a
top-level chat without "└", until a reload. `GET /api/chats` has `forkParents`; the chat.updated events of a chat of one
person did not (ChatRuntime.publishChat built the chat with `store.toChat`, not with chatView, so it also lacked
`forkedFrom`). Second, `GET /api/chats?ids=…&limit=5` answered 200 though `ids` stands alone.

## Scope

In:
- Server: publishChat's one-person chat goes through chatView (forkParents, forkedFrom, as the list). Every chat.updated
  to the chat's own person carries `forkParents`, `[]` for a top-level row (shared.ts `liveChat`), so a window tells "not
  said" from "none" (a detach in another window). Lists and answers keep leaving the field out for a top-level row.
- Web: chat.updated merges in store/chats.ts and store/projectPage.ts keep the parents a list knows when an event leaves
  them out (an older server), never make any up, and drop them on `[]` (lib/forkTree.ts `withForkParents`).
- `GET /api/chats?ids=` with `limit`: 400 (`query.ids: alone`). No client sends both (checked: store/chats.ts sends ids
  alone).
- Mock (web/test/mock/server.ts): my own chat's PATCH tells my windows like the server; a test hook sends a chat.updated
  without forkParents.

Out: no change to how the list builds its tree, no migration.

## Steps

1. Server fix + `liveChat` at each chat.updated with a chat row (runtime publishChat, nav-folders, routes/chats.ts).
2. Client merge helper and its two uses.
3. `ids` + `limit` refused; contract comment.
4. Tests: server events (send, rename, pin, created, detach, another person's view), web store per live path, e2e.

## Decisions

None new; follows docs/decisions/20261126-chat-fork-tree.md and 20261127-fork-in-history.md.

## Risks

- One more `forkParentsOf`/`forkedFromOf` read per chat.updated of a one-person chat: a few indexed lookups.
- A shared chat: only its creator gets forkParents, as before.

## Tests

- `tests/unit/b-chat-fork-tree.test.ts` "chat.updated carries forkParents"; `tests/unit/b-fork-in-history.test.ts`
  ids + limit 400.
- `web/test/unit/fork-parents-live.test.ts`.
- `web/test/e2e/chat-fork-tree.spec.ts` "the └ stays through a reply, a rename and changes from another window".
- typecheck, check:prepush, web unit, chat server + security tests, chat-fork-tree and chat-fork e2e, Bun 1.3.12.

## Result

Done as planned. Root cause: ChatRuntime.publishChat built a one-person chat with `store.toChat` (no forkParents, no
forkedFrom). The new server test fails on dev and passes here; the web store test and the e2e step with an event
without forkParents fail without the client merge. Bun 1.3.12: typecheck, check:prepush, web unit 4741/0, 31 server
files that use chat.updated (unit + security) 532/0, chat-fork-tree + chat-fork e2e 20/20. Not from this change:
project-chat-row-menu.spec.ts (the row menu has the fork item now) and two chat-look.spec.ts tests fail the same with
dev's mock.
