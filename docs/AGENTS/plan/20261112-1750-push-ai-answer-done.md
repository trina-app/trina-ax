# A phone push when an AI chat answer needs me (QA TC-442)

- Date (UTC): 2026-11-12 17:50
- Branch: `feat/push-ai-answer-done`
- Status: done
- Where: server/src/notifications, server/src/chat/turn.ts, shared/src/api, web (settings switch, service worker). Why:
  notifications and push are Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: minor, a new notification and setting (additive migration, reader 1).

## Goal

Pushes arrive for room messages, mentions and scheduled tasks, but not when an answer in my own AI chat finishes or
waits for me. Someone who asks Trina something and puts the phone away never hears that the answer is there. After
this, the person who asked gets one push when the answer ends (finished or failed) or when the AI waits for them (a
question or a yes/no card), unless they are looking at that chat. A tap opens the chat.

## Scope

In:
- New event `chat.answer_done` (one code; the notice keeps the kind: done, failed, waiting) in its own table
  `chat_answer_notices` with `chat_answer_push_deliveries` (notification_inbox has a fixed event_type list).
- Made by the turn: when it ends (done or error; not stopped by the person, not a server stop) and when a card that
  every window shows opens. Only for the asker of the turn (`spec.userId`), never a scheduled run, a question from
  Slack or a room AI answer.
- One notice per answer: the source is the turn (a card: `<turn>.ask`, at most one per turn). A new finished answer of a
  chat whose earlier finished-answer notice was not seen since adds none (a burst is one push).
- Presence: the server does not know which chat a window shows, but a visible window that has the chat on screen marks
  its answer seen (POST /api/chats/:id/seen). The push waits 10 s (a card 30 s) and goes only while the answer is still
  unseen (a card: while it is still open). A shared chat's seen mark is its creator's, so for another asker it still
  sends (coalesced as above).
- Push: a new SOURCES entry in push-service.ts (Web Push and the phone gateway, with the badge). Path `/c/<chatId>`
  (the web's chat page). Lock screen: generic words in the person's language, no title, no text (TC-365). The iPhone's
  extension acts on `room.*` only, so no label and no app build.
- Setting: Settings › Notifications "AI answers" switch (`chatAnswers`, default on). Turning it off cancels waiting
  deliveries.
- Gateway text for `chat.answer_done` (the gateway shows "You have a new message" for `chat.*` until it is deployed).

Out: an Inbox row for it (the sidebar's markers already show these chats; the notice is listed nowhere), quiet hours,
the chat title on the lock screen.

## Steps

1. Migration 347: `chat_answer_notices`, `chat_answer_push_deliveries`, `notification_preferences.chat_answers`.
2. shared: event code, `chatAnswers` preference, push messages.
3. server: Notifications.chatAnswer, turn hooks, push source (delay + wanted), path, cancel on opt-out, text.
4. web: settings switch, service worker (code, click opens the chat), i18n in five languages.
5. Tests, docs (DECISIONS), changelog fragment.

## Risks

Migration 347 (highest on dev: 346; 1xx would run before notification_preferences exists). Additive, reader 1. A push
while the person is looking at a card (no presence for cards): 30 s wait, once per turn.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the notifications and push unit tests, a new server
test and a web unit test for the switch.

## Result

Built as planned: `chat.answer_done` (done / failed / waiting) in `chat_answer_notices` (migration 347) with its own
deliveries, the turn hooks, a delayed push that checks the seen mark or the open card, `/c/<chatId>`, the "AI chat
answers" switch and the gateway line. Added on review: turns the server starts by itself (no client: skill drafts,
merges, file ranking) are not told. Server-side only: no phone build; the gateway's own wording needs its next deploy.

