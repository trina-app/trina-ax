# b-fewer-asks-recipients: each test starts with a full send budget

- Date (UTC): 2026-11-24 17:00
- Branch: `fix/fewer-asks-test-send-budget` (off `dev`)
- Status: done
- Where: tests/unit/b-fewer-asks-recipients.test.ts. Why: it failed in the merge queue (run 45427899919, #542), knocking batches out.
- Version impact: none (test only).

## Goal

"a teammate left out by a short name: the card shows" failed with 429 rate_limited at `chatWith` (PUT /api/chats/:id/audience).

## Cause

Changing a chat's people takes a room send token (server/src/chat/people-share.ts putChatAudience, `takeSendToken`). The budget is SEND_BURST (20), then 1 a second, per person and across all rooms. bob's tests in this file post to rooms and share chats more than 20 times together. A fast runner does that inside a second, so a late test gets 429. Whether it fails depends on runner speed.

## Fix

The same as tests/unit/b-chat-thread-mentions.test.ts: `beforeEach` clears the rooms send budget, so each test starts with a full one. Nothing a test checks changes. The budget itself stays tested in b-answer-share.test.ts.

## Tests

30 runs of the file on dev and 30 with the fix, on the Mac mini.

## Result

(filled after the runs)
