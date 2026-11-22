# A new message in a chat shared with people tells the others

- Date (UTC): 2026-11-22 02:22
- Branch: `fix/shared-chat-new-message-notices`
- Status: in progress
- Where: server (chat, notifications), shared (api), web (markers, sound, chat menu). Why: a people-shared chat is a
  conversation, and today nobody hears about a teammate's message there (scenario QA TC-7406, TC-r2b-07, TC-r2a-01)
- Version impact: minor. A new notice kind, a new menu item and a migration (additive).

## Goal

Today only thread replies notify in a chat shared with people. When a person writes there, the creator and the members
see nothing until they open the chat. Slack tells you about every new message in a DM or group DM. This change does the
same for a chat shared with people.

## Scope

In:
- A **person's** message in a people-shared chat (`chats.people_shared_at`, not a project chat) gives every other person
  who sees the chat now (`Audiences.ofChat`: creator, people, groups; members added later included, the sender left
  out) a notice: an unread number on the chat's row (the Trina list), counted in the one count n (the rail mark, tab
  title, Dock, app icons), plus a push and a desktop notification with the room sound.
- Every message is its own notice and push, grouped under the chat on the phone, as rooms do since TC-5585
  (docs/decisions/20261120-push-every-message.md). A desktop notification is one per chat (a newer one replaces it).
- **Trina's answer**: the asker keeps the existing "finished" notice (chat-answers.ts; #319 owns it). The other people
  get only the unread number (a notice that is never pushed, no desktop notification, no sound).
- Settings: the push follows the room default (Settings › Notifications › conversations: `none` turns it off, as for a
  group chat), quiet hours (made inside: never pushed) and the away rule (push-service.ts phoneDecision, unchanged).
- Per chat **Mute this chat / Unmute** in the chat menu, for anyone who sees a people-shared chat. Muted: no notices at
  all for that person (no number, no push), as a muted Slack conversation.
- Visibility: a notice only for someone who sees the chat now and not for an answer hidden from them; the push checks
  again before it goes (`chatOpenFor`).
- Opening the chat (POST /api/chats/:id/seen, any viewer) reads that person's notices and cancels waiting pushes.
  Sending in the chat reads them too.
- A tap opens the chat at that message: `/c/<chat>/m/<message>` (a new route reading it as `?answer=`).

Out: an Activity row per message (rooms list no row for a DM message either; the chat row's number shows it), message
preview text in the push, project-shared chats (their own behaviour, not asked), a muted chat's grey count.

## Steps

1. Migration 436 (above #324's 435): `chat_message_notices` (kind `message` | `answer`, quiet), its
   `chat_message_push_deliveries`, and `chat_mutes`.
2. `server/src/chat/message-notices.ts`: `noteSharedMessage` (from `runtime.createTurn`, before its chat.updated),
   `noteSharedAnswer` (from `turn.ts announceEnd`, before its chat.updated), `readChatNotices`, `unreadOf`, mute,
   push `wanted`/`path`/label.
3. Push: a SOURCES entry (`AND kind='message' AND quiet=0`), push path, event code `chat.message` in `PushEventType`,
   text equal to the gateway's generic message line (no gateway deploy), `cancelDisabledPushDeliveries`, the phone
   label (chat title, generic line), the Inbox `get` for the service worker (link chat) and sw.js.
4. `chatView`: `unreadCount` and `unseen` for a people-shared chat per viewer, `muted`. `chat.updated` gets `notice`
   (the message id) for the people whose notice may ring. push-badge.ts reads the same.
5. Web: `markerOf` shows a number for a chat with `unreadCount`; attentionCount counts its messages (as a group chat);
   sessionMarkers tells it on the desktop; the room sound rings (RoomSound.notice); chat menu Mute/Unmute; the new
   route; i18n in six languages.
6. Tests: `tests/unit/b-shared-chat-message-notices.test.ts`, web unit tests for the marker and count.
7. Decision file, changes file, docs:api.

## Decisions

docs/decisions/20261122-shared-chat-new-message-notices.md

## Risks

- Overlap with open PRs: #321 (thread mentions: threads.ts, roomSound, sessionMarkers), #319 (turn.ts finished notice),
  #324 (migration 435, service.ts, chat menu, i18n). Edits kept in separate places; migration 436.
- Noise: answers never ring; mute per chat; room default `none` stops pushes.
- Count cost: one indexed COUNT per people-shared chat in a list (index on user_id, chat_id, read_at).

## Tests

`bun run typecheck`, `bun run check:prepush`, the new unit test and the touched notification/chat tests, web unit
tests. Visual check on a private QA copy with two users at 1440 and 390.

## Result

(at the end)
