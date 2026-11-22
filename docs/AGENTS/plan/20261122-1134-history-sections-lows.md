# History sections: two Lows from the #387 security review

- Date (UTC): 2026-11-22 11:34
- Branch: `fix/history-sections-lows` (stacked on batch #391)
- Status: done
- Where: server/src/chat/nav-folders.ts. Why: the review of #387 (approved) left two Lows.
- Version impact: patch (fixes; no API change)

## Goal

1. GET /api/nav-folders no longer works out a people-shared chat's whole audience per filed row (15k rows held the
   event loop ~500 ms): the SQL already checked that I am in it; what is left is about me (active, not a guest unless
   it is my own chat), read once per call.
2. A row of a chat I lost can be taken out (PUT /api/chats/:id/folder with null deletes my own row by my id and the
   chat's before the chat is read; the answer is the same as before, so it says nothing about a row), and a section
   that is full drops the rows of chats I hid or lost before it refuses (it never says full while it shows fewer).

## Steps

1. visibleChatItems: people-shared rows checked against me once; project-shared rows keep the per-project audience.
2. setChatFolder(null): delete my row first; makeRoom: after the trash, the rows of chats not in my history go.
3. Tests: tests/unit/b-nav-folders.test.ts (full section, taking out a lost row with the same 404).

## Decisions

docs/decisions/20261122-trina-history-sections.md "Who can go in": the full-section line follows step 2.

## Tests

typecheck, check:prepush, b-nav-folders and the shared-chat suites under Bun 1.3.12, the security permission matrix.

## Result

As planned.
