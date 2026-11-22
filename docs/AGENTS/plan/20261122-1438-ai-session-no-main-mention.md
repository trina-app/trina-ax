# No @mention in an AI chat's main message box; mentions only in threads on AI answers

- Date (UTC): 2026-11-22 14:38
- Branch: `fix/ai-session-no-main-mention`
- Status: in progress
- Where: server/src/chat, server/src/notifications, shared/src/api, web/src. Why: owner decision on how people mention each other in AI chats (see docs/REPOSITORY-RULES.md)
- Version impact: minor (a visible change: the main box of an AI chat no longer offers "@" people, and its messages no longer list under Mentions)

## Goal

Owner: "Shouldn't mention be disabled in shared projects and shared sessions? In a shared project session it should
only be possible in the threads on AI answers." A test user sent "@dion ㅎㅇ" in a shared chat's main box and the AI
answered it. The main box of an AI chat (a chat shared with people, a project's chat) is for talking to the AI.

## Scope

In:
- Web: the AI chat's main composer gets no member list (no "@" picker, no mentions sent).
- Server: a main message's `mentions` are ignored (field still accepted, so an older client's send does not fail);
  no mention notice is made, a muted person is never told (no mute bypass), no "@" on the chat row from new messages.
- Undo the Mentions-tab rows for main-box mentions (#364): not listed, counted or marked read in Activity; their
  "mentioned you" texts go.
- Thread mentions under AI answers (#321/#360) stay as they are. Project chat rooms (대화방) stay as they are.

Out:
- The plain new-message notices of main messages (#339/#360: unread number, push, mute) stay.
- Existing messages and notice rows stay (no migration); old `mention = 1` rows are simply no longer read as mentions.

## Steps

1. Web: Chat.tsx stops fetching `mentionable` for the main box; Composer loses `mentionPeople`.
2. Server: routes/chats.ts and runtime.ts stop passing `mentions`; message-notices.ts writes `mention = 0`, drops the
   mute bypass and every mention read; notifications/service.ts drops MENTION_ROWS listing, count and reads;
   people-share.ts drops the "mentions gone" Inbox refresh.
3. Shared: activityTabHas no longer lists chat.message; the chatMessage notice shape back to `{ messageId }`.
4. Web: Activity, inbox store and notice texts drop the chat.message rows; i18n keys `message_mention*` go.
5. Decision file superseding docs/decisions/20261122-main-box-mentions-listed.md.
6. Tests: main message with mentions makes no mention notice (also reaches no muted person); thread mentions still
   notify; the AI chat composer shows no picker; the thread composer's picker works; a room's picker unchanged.

## Decisions

docs/decisions/20261122-ai-session-no-main-mention.md (supersedes docs/decisions/20261122-main-box-mentions-listed.md
and the main-box mention part of docs/decisions/20261122-shared-chat-new-message-notices.md).

## Risks

No migration. Six app languages (keys removed in all). The GET …/audience `mentionable` list stays (the Files screen's
restore confirm reads it).

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit for shared chat notices and thread mentions, web unit tests.

## Result

(filled in at the end)
