# Project chats tell their people of new messages; thread replies ring only on a mention

- Date (UTC): 2026-11-22 05:25
- Branch: `fix/project-chat-notices-threads-mention-only` (on `batch/20261122-i`, which holds #339 and #350)
- Status: done
- Where: server/src/chat (message notices, threads), server/src/rooms (thread reply notices), notifications
  preferences, web (chat menu, composer mentions, thread switch default). Why: owner decision 2026-11-22
  ("ㅇㅇ 그게 맞지. 스레드는 원래 멘션 없으면 안오는거임").
- Version impact: minor (project chats get a new notice kind and Mute; a changed default; one data migration)

## Goal

1. A team project's shared chat is a conversation too: a person's message on its main timeline tells the project's
   other people who see the chat (unread number on the row, the Projects rail mark of #350, push, desktop notice,
   sound), as a chat shared with people does since #339. "Mute this chat" works there. Trina's answers raise only the
   number for the others; the asker keeps the "finished" notice.
2. A reply in a thread never rings by itself (no push, desktop notice or sound): only a reply that @mentions me does,
   in rooms, chats shared with people and project chats alike. The thread still shows as new in "Mentions & threads".

## What rooms do today (checked)

- Rooms' threads (`roomAlert`, shared/src/api/room-alerts.ts): a reply in a thread I follow rings when "Replies in
  threads I'm part of" (`roomThreadReplies`, default ON) is on; a mention rings at every level but off. With the switch
  off, a followed reply makes no room notice at all, so no row in Mentions & threads either.
- Chat threads (#321, chat/threads.ts): one notice per thread, always listed in Mentions & threads; push, desktop notice
  and sound follow the same switch. Bug: `chatThreadWanted` checks the switch before the mention, so with the switch off
  a mention's push is dropped too; and a mention that lands on a thread notice that is already open is never pushed
  (its delivery row already exists).
- The switch is one setting for rooms and chats, so it stays. Its default becomes OFF and its meaning "also ring for
  replies without a mention".

## Scope

In:
- `message-notices.ts`: a project-shared chat (`isProjectSharedRow`) is a conversation row like a people chat
  (`isConversationRow`). Same audience gate (`Audiences.ofChat`: the project's readers now, no guest but the chat's
  own, nobody while its folder is in the trash; "Only me" chats are not shared so tell nobody); answers skip anyone they
  are hidden from (`AnswerSight`). The fan-out is batched: active people, mutes and preferences in one query each,
  inserts in one transaction, the list-hidden rows in one statement; no query per person beyond the insert.
- `Audiences`: `activePrincipals` loads users and their groups in two queries (was two per person).
- `publishChat`: the unread numbers and mutes of the chat for every viewer in one grouped query, handed to `chatView`.
- `chatView`, push badge, `POST /seen`, mute routes: people **or** project chats. The web "Mute this chat" item and the
  main box "@" list for project chats too (`mentionable`: the project chat's people but me, as the thread box lists).
- Coalescing as rooms do (TC-5585, docs/decisions/20261120-push-every-message.md): every person's message its own
  notice and push (the phone groups them under the chat), the desktop notification one per chat (a newer one replaces
  the pending one), Trina's answers never pushed or rung. Nothing new to add there.
- Threads: default `roomThreadReplies` OFF (code default, the web's fallbacks, and migration 437 turns it off for
  every saved row: it was on by default and could only be turned off, so nobody chose it). Rooms: a followed reply
  without a mention with the switch off is a quiet notice (listed in Mentions & threads as before, never pushed, rung or
  told). Chats: a mention is pushed whatever the switch; a first mention on an open thread notice is pushed again.
  Settings text says what the switch does now.

Out: changing #350 (it reads `unreadCount`, which is now real); the badge test of #339 (fixed in the batch already,
1dedcd68b); project rooms (rooms linked to a project keep their 멘션만 default).

## Steps

1. Server: message-notices.ts, shared.ts (Audiences, chatView), runtime.ts publishChat, push-badge.ts, routes/chats.ts
   (seen, mute), people-share.ts (`mentionable` for project chats), shared/api summary text.
2. Threads: preferences default, migration 437, threads.ts (wanted, re-arm), rooms/service.ts recordNotices, web
   fallbacks and Settings text in six languages.
3. Tests: tests/unit/b-project-chat-message-notices.test.ts (3 people in a project: numbers, push rows, mute, mention
   through mute, guest and Only-me, answers number only, query count does not grow per person), thread tests (plain
   reply: no ring in room or chat; mention: ring with switch off; Mentions & threads rows still there).
4. Gates: typecheck, check:prepush, area unit tests, web unit tests (Bun 1.3.12).
5. Visual check on a new private QA copy (3 users in a project; 1440 and 390).
6. Decision file docs/decisions/20261122-project-chat-notices-threads-mention-only.md, changes/ note.

## Decisions

docs/decisions/20261122-project-chat-notices-threads-mention-only.md. Extends
docs/decisions/20261122-shared-chat-new-message-notices.md (its "Left out: project-shared chats") and
docs/decisions/20261118-chat-thread-mentions.md; changes the default of "대화방 알림 설정" (docs/DECISIONS.md).

## Risks

- Migration 437 (highest on dev 434, 435/436 in the batch). Data only; a rollback build reads 0 as off.
- Busy project chats: many pushes (the gateway's 20 a minute per device, as rooms since TC-5585).
- Who sees: only `Audiences.ofChat`; the push checks `chatOpenFor` again before each send.

## Tests

See step 3. Plus the existing b-shared-chat-message-notices, b-shared-chat-message-push, b-chat-thread-mentions,
b-chat-answer-threads, b-rooms-threads, b-push-every-message and web room-sound / session-marker tests.

## Result

Built as planned, plus what the reviews and the QA copy found:
- Plan review: the push gate (`pushEventEnabled`) and the service worker both blocked a thread mention with the switch
  off; both now leave it to `chatThreadWanted` (a reply that still mentions the person, or the switch on). A mention on
  an open notice is re-dated and its finished deliveries go, so it is pushed anew.
- A member who never wrote in a project chat: `GET /api/chats?unread=1` (kept in the web store's `others`, counted in n
  as the push badge counts them) and the push badge reach it. Project rows are bold and their chat rows show the
  number. "Mute this chat" is in the chat's title menu too.
- QA copy: opening a chat put the store's older copy back over the newer chat.updated (the Projects mark stayed);
  pages/Chat.tsx upserts only a copy it read now.
- Code review: the badge and the unread list keep a project chat only while it is one and I see it (filtered before
  the page); an answer's hidden-from check runs before the write.
- Left as is: notices of someone who lost a project stay until read or 30 days (never pushed, never shown).
Checked in a private QA copy (3 people in a project, 1440 and 390): shots in ~/qa-projnotice-shots/.
