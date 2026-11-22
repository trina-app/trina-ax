# Shared-chat thread mentions reach the person: Mentions & threads and the desktop notification

- Date (UTC): 2026-11-22 00:58
- Branch: `fix/chat-thread-mentions`
- Status: in progress
- Where: server/src/notifications/service.ts (the Inbox list and "Mark all as read"), server/src/chat/threads.ts (the
  thread's realtime event), shared/src/api (activityTabHas, the chat.thread event), web Activity / inbox count / session
  markers. Why: the notice is made on the server (chat/threads.ts sendReply, docs/decisions/20261118-chat-thread-mentions.md)
  but no conversation surface shows it
- Version impact: patch, a bug fix (no new API, no migration; one optional field on a realtime event)

## Goal

The owner wrote "@test" in a thread under a Trina answer of a chat shared with one person. The mention showed, the
person got nothing they could see. Reproduced on a QA copy: the server stores the mention, makes the person's
`chat.thread_reply` notice with `mention` and its push row, but

1. the notice is listed only with the app's own notices (`only=notices`, 활동 beside the rail on a computer), never in
   대화's 멘션·스레드 (`only=rooms`), and its Mentions / Threads tabs never hold it (`activityTabHas` knows only room
   rows); the 대화 mark and the 멘션·스레드 row do not count it;
2. the desktop app tells a room mention as a system notification (`room.message` `notice`), never a chat-thread one.

After this change a chat-thread reply notice is a conversation row like a room thread reply: in 멘션·스레드 (All, Threads,
and Mentions when it mentions me), counted on 대화 (not on 활동), read by "Mark all as read" there, and told by the desktop
app while the window is not focused. A tap opens `/c/<chat>/t/<answer>` (unchanged). Push is unchanged (already sent).

## Scope

In:
1. `notifications/service.ts list`: `only=rooms` also lists `chat_thread_notices`; `only=notices` leaves them out;
   `roomUnreadCount` counts them, `noticeUnreadCount` does not. `readAll`: the chat-thread rows follow the same tab rule.
2. `shared activityTabHas`: `chat.thread_reply` is under Threads, and under Mentions while `chatThread.mention`.
3. `chat/threads.ts sendReply` / `fanOut`: the `chat.thread` event carries `notice: 'mention' | 'reply'` to each person
   who got a notice from this reply (optional field; an older page ignores it).
4. web: `pages/Activity.tsx` shows the chat-thread rows on 대화's page; `store/inbox.ts` counts them as conversation
   rows; `store/sessionMarkers.ts` tells them in the desktop app (the generic words of the Inbox, the chat's title).
5. Tests: unit (server list / tabs / read all / event notice; web tab rule and the desktop tell).

Out: the people who see the thread (`threadPeople`, `Audiences`) and who follows it: TC-7406 (a person added later)
is changed by another branch. Push wording and gateway. Mentions in the chat's main box.

## Steps

1. This plan.
2. Server, shared, web changes and tests.
3. QA copy (two users, 1440 and 390), review, PR into dev.

## Decisions

none (follows docs/decisions/20261118-chat-thread-mentions.md and the rooms' conversation-row rule)

## Risks

- A phone app built before this reads `noticeUnreadCount` for 나: the chat-thread rows move from 나 to 대화's dot, as room
  rows already are.
