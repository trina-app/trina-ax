# Chat thread mentions: a deleted mention falls back, the people list is cheaper

- Date (UTC): 2026-11-18 07:24
- Branch: `fix/chat-thread-mention-followups`
- Status: done
- Where: core (server/src/chat/threads.ts, server/src/notifications/service.ts). Why: follow-up to the chat thread mentions in core chat code.
- Version impact: patch. It fixes a wrong Inbox line and cuts work done on each load. Nothing new to see.

## Goal

QA TC-4853, review follow-ups to #1260:
1. An unread notice with mentions in replies A and then C: deleting C made the Inbox row say "replied" although A
   still mentions the person.
2. `threadPeople` ran on every page of a thread and judged every answer of the chat for every person in the audience.

## Scope

In: the notice keeps its first mention (`mention_id`) as the start of the replies to look through. The Inbox row takes
the newest reply still there between it and the notice's newest reply that mentions the person. `people` is sent with
the first page only (the app keeps it while reading older ones). Each person is judged on the answer and the messages
above it only, with the chat read once per call.
Out: no schema change (migration 417 as merged).

## Result

Done. Tests in tests/unit/b-chat-thread-mentions.test.ts and web/test/unit/chat-thread-mentions.test.tsx.
