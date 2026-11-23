# "Replies in threads I'm part of" on by default, as in Slack

- Date (UTC): 2026-11-23 08:16
- Branch: `fix/thread-replies-default-on`
- Status: done
- Where: server/src/notifications, server/migrations, web settings (Team AX core). Why: the default lives in
  preferences.ts and the saved values in notification_preferences.
- Version impact: minor (a changed default and a data migration)

## Goal

The owner (2026-11-23, "슬랙처럼 기본 켜기"): a reply in a thread I follow notifies me (push, desktop, sound) by
default, as in Slack. Supersedes the default-off part of 20261122-project-chat-notices-threads-mention-only.md.

## Scope

In: migration 449 (room_thread_replies = 1 for everyone, undoing 437; the table has no save time, so people who turned
it off after 437 cannot be told apart and are flipped too); preferencesOf(null) → on; the web switch reads a missing
value as on; the web mock's default; stale comments; a decision file; changes note; tests.
Also (QA nit of #437): the AI app connect command box wraps at spaces, breaking a long token (a URL) only when it does
not fit (`[overflow-wrap:anywhere]` instead of `break-all`).
Out: who follows a thread (unchanged, #441).

## Steps

1. Migration 449 (448 is taken by open PR #442).
2. preferences.ts, RoomNotifySettings.tsx, web mock, comments.
3. Tests: b-rooms-notify, b-rooms-thread-root-mention, b-project-chat-message-notices, b-chat-thread-mentions.
4. AiAppConnect.tsx wrap.

## Decisions

docs/decisions/20261123-thread-replies-default-on.md.

## Risks

Migration number (449: dev has 445, open PRs 445–448). People who chose off after 437 are turned on (no way to tell).

## Tests

`bun run typecheck`, the room/chat thread and notify unit tests, web unit room-notify, tests/security, check:prepush.

## Result

Built as planned. The wrap rule was measured in Chromium: at 560 px the command keeps "--scope user" whole and breaks
only the long URL; at 300 px nothing overflows.
