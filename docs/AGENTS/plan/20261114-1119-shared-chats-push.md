# A phone push that names who shared a chat with me (TC-1414)

- Date (UTC): 2026-11-14 11:19
- Branch: `feat/shared-chats-push` (on `feat/shared-chats-p3`, #821)
- Status: done
- Where: Team AX core (`server/src/notifications/`, `push-gateway/`, `mobile/plugins/notification-service/`,
  `web/pwa/sw.js`, Settings › Notifications). Why: notifications and phone push are core.
- Version impact: minor, a new push and a new setting; additive migration, no contract break.

## Goal

A person a chat is shared with **by name** gets a phone (and browser) push that names the sharer, never the chat's
title. Group shares keep the Activity row only. At most one per chat and person a day. A per-person setting "Chats
shared with me" (default on) turns the push off.

## Scope

In: push code `chat.shared` (the Inbox's), its deliveries table and the `chat_shares` preference (migration 351);
the push service source, path (`/c/<id>`), quiet hours, "only when away", cancel on switch-off; the label answer for
the iPhone extension (sharer's name + a fixed line); gateway generic text and mutable flag for the code; the iPhone
extension accepts the code; the browser service worker shows it; the Settings switch in six languages.
Out: naming the sharer on Android (it has no extension; same as room pushes).

## Steps

1. Migration 351: `chat_share_push_deliveries`, `notification_preferences.chat_shares`.
2. `notifications/chat-shares.ts` (wanted, path, label); push-service SOURCES + label; push-events path + cancel;
   preferences `chatShares` and `pushEventEnabled`; text.
3. Gateway `EVENT_TEXT['chat.shared']`, `mutableCode`; contract comments; README.
4. iPhone extension: `chat.shared` asks for the label.
5. Service worker + Settings switch + i18n.
6. DECISIONS, changes fragment, tests.

## Risks

Old gateway: `chat.*` fallback "You have a new message", no mutable flag. Old iPhone build: generic line. Old browser
worker: drops the code. Migration number 351 (dev's highest is 350; #826 takes 299).

## Tests

`bun run typecheck`, push-gateway typecheck, `check:i18n`, `check:docs`, the push/notification/share/mobile unit
tests, web unit.

## Result

Built as planned. A same-day group notice for someone later taken out and named becomes a share by name (one row,
pushed once). Tests: tests/unit/b-chat-share-push.test.ts, web/test/unit/push-worker.test.ts and the updated gateway,
locale, rooms-notify and mobile-labels tests.
