# An answer that fails at once never sits on "Thinking…"; a long AI limit says until when

- Date (UTC): 2026-11-19 02:15
- Branch: `fix/thinking-stuck-no-usage`
- Status: done
- Where: Team AX core (`web/src/store/thread.ts`, `server/src/chat/turn.ts`, `shared/src/api/errors.ts`,
  `web/src/lib/chatErrors.ts`, chat error words in every locale). Why: chat streaming and AI usage are core.
- Version impact: patch

## Goal

Owner report 2026-11-19 on the company server: "hi" in a new private chat stayed on "Thinking…" with Stop until the
page was reloaded. The server had ended the turn 0.1 s after it began (every team Claude account at its weekly limit
for about two more days) and stored the error; the reload showed "The AI usage limit was reached for now. Try again a
bit later.", which was not true either: the wait was two days.

## Cause

The page was reading the chat's messages when the events came. `message.created` of the running answer waited for the
read (chats.ts `held`); `message.done` with the error does not wait and was applied. When the read ended, the waiting
`message.created` was replayed and `applyCreated` replaced the finished answer with its running copy. The quiet check
(QA TC-3521) did not read again, because the page remembered that the answer had ended. Only answers that end within
the read's round trip hit it, so fast failures (usage used up, no AI account) did, normal answers did not.

## Scope

In: `applyCreated` keeps a finished answer when an older running copy arrives (as `mergeFresh` already did). A provider
limit longer than an hour (credentials/resolve.ts SOON_MS) becomes reason `usage_used_up` with `params.until`, still
code `rate_limited` (the "answer with another AI" fallback still follows). The web app says until when; the owner and
admins read "connect another AI account in Admin › AI providers", a member "ask your admin to add more AI usage". No
plain Retry while the limit lasts ("retry with another model" stays).
Out: the composer's "No AI is connected yet" banner while an AI is connected but used up (needs the until time in
`GET /api/me/ai-access`); a follow-up QA row.

## Steps

1. web/test/unit/chats-fast-failure.test.ts: the end comes during a read (fails on the old code), and before the send is
   answered.
2. thread.ts applyCreated guard.
3. turn.ts `limitError`, shared `usage_used_up`, web words by role, tests (b-usage-used-up, chat-error-words).

## Decisions

- One hour as the line between "for now" and "used up": the same line "No AI" in Admin › Members uses.
