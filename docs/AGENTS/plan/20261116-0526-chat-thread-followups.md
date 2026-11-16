# Threads on AI answers: the security review's follow-ups (TC-3783 … TC-3788)

- Date (UTC): 2026-11-16
- Branch: `fix/chat-thread-followups` (on top of #1060)
- Status: done
- Where: trina-ax core: `server/src/chat/threads.ts`, `server/src/realtime/hub.ts`, `shared/src/api/chats.ts`,
  `web/src/components/chat/ChatThreadPanel.tsx`. Why: chats and permissions live in the core (docs/REPOSITORY-RULES.md).
- Version impact: patch (fixes to #1060; one additive migration, reader 1)

## Goal

Close the Low findings of #1060's security review and one older one it found:

- TC-3783: a chat in the trash shows no Delete on replies (read-only).
- TC-3784: no reply delete while safe operations are on: hidden, and the API refuses it (409 safe_ops) like other writes.
- TC-3785: a purged chat's thread notices go with it (migration 409: triggers on messages and chats; leftovers removed);
  `chat_thread_notices.by_user` is decided in the account-removal coverage.
- TC-3786: a newest reply longer than the 4,000-character draft cap still goes into Send to Trina's draft, cut with "…".
- TC-3787: tests for a hidden answer and a chat in the trash: the same 404 on all four routes.
- TC-3788 (older than threads): a chat's realtime events are replayed only while the person still sees the chat
  (`hub.ts stillVisible` re-checks `chatFor`); someone taken out of a people-shared chat while offline gets resync.

## Steps

1. Server gate: `canDelete` false and delete refused in the read-only states; migration 409; account-removal list.
2. Shared draft builder; web panel hides Delete in the read-only states.
3. Hub replay check for chat events (`chat/threads.ts chatVisibleTo`; no chat runtime: nothing to check).
4. Tests: `tests/unit/b-chat-threads.test.ts` (each finding; the replay test fails without the hub change),
   `web/test/unit/chat-threads.test.tsx` (the draft).

## Decisions

The rules join `docs/decisions/20261116-chat-answer-threads.md` (delete in read-only states; the replay rule).

## Risks

Migration number (409, B's range; re-check before the PR). The replay check runs `chatFor` per chat in a replay: a
reconnect of a busy window costs a few reads.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, the thread, realtime, shared-chat, guard and security tests.

## Result

As planned. `tests/security/r2-realtime-resume-revoked.test.ts` keeps its one failure, which fails the same on dev.
