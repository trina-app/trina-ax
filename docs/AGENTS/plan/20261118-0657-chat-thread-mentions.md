# @mentions in the thread under an AI answer of a shared chat

- Date (UTC): 2026-11-18 06:57
- Branch: `feat/chat-thread-mentions`
- Status: in progress
- Where: core (server/src/chat/threads.ts, web/src/components/chat/ChatThreadPanel.tsx). Why: chat threads are core chat code (docs/REPOSITORY-RULES.md).
- Version impact: minor, a new feature with an additive migration that older builds can read.

## Goal

QA TC-4849. In a shared chat's thread ("Thread", box "Reply…") nobody can tag a person: the box takes words only.
The owner wants to tag the people of the project. After this change, typing @ in the thread's reply box lists the
people who can see this chat now. A picked person stands out in the reply as in rooms and gets a notice that opens
the thread.

## Scope

In:
- The reply box uses the rooms' mention box (TokenTextarea + useMentionMenu, no "@everyone"), with exactly the people
  who see the thread now (`ChatThreadPage.people`: the chat's audience, Audiences.ofChat, minus the caller, minus
  anyone the answer is hidden from). A guest only when the chat's audience holds them.
- Replies keep `mentions` (ids). The server keeps only ids that are in the audience now and see the thread
  (threadVisibleTo), never the caller, in the order given. The client's list is never trusted.
- Replies render their mentions as names with the rooms' mention look (lib/messageMarkdown.ts mentionClass, PersonButton).
- A mentioned person follows the thread (as a room thread's mention does), so later replies notify them and the
  thread line shows the unread dot by the existing rule. They get the thread's one notice per thread. It is marked as
  a mention (`mention_id`), and the Inbox row says "{name} mentioned you in a thread in {title}." The push is the existing
  thread push: generic words, after 10 s, it follows "Replies in threads I'm part of" and quiet hours, and a tap opens
  `/c/<chat>/t/<answer>`.
- Migration 417 (component B): `chat_thread_replies.mentions` (JSON array, default '[]'),
  `chat_thread_notices.mention_id`.

Out:
- The shared chat's main box (messages to the AI). It is another component (chat/Composer.tsx), its messages are AI
  turns stored in `messages`, and a mention there would need its own storage, rendering, prompt rules and notices.
  This is not a small change, so it is left out.
- A push type of its own ("mentioned you"). It would need the push gateway, the service worker and the phone app.
- Editing a reply (replies have no edit).

## Steps

1. Migration 417; threads.ts: validate and store mentions, follow + notice, `people` on the page, notice `mention_id`.
2. shared: `ChatThreadReply.mentions`, `SendChatThreadReplyBody.mentions`, `ChatThreadPage.people`, Inbox `chatThread.mention`.
3. Web: ReplyBox on TokenTextarea + useMentionMenu (`everyone` off); reply text with mentions; store sends mentions; Inbox line.
4. i18n en first, then the other locales; changes/, decision file.
5. Tests: server (audience validation, outsider/guest/hidden dropped, notice + follow), web (picker list), e2e if there is a pattern.

## Decisions

docs/decisions/20261118-chat-thread-mentions.md

## Result

(filled in at the end)
