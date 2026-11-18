# @mentions in the thread under an AI answer of a shared chat

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "Not added: mentions" line of docs/decisions/20261116-chat-answer-threads.md
- Branch: feat/chat-thread-mentions (QA TC-4849; the owner: "you should be able to tag people in the project")

Plan: docs/AGENTS/plan/20261118-0657-chat-thread-mentions.md

- **Ask:** in a shared chat's thread, a person can tag the people of the project. Before this change the reply box took
  words only.
- **Rule:** typing "@" in the thread's reply box lists exactly the people who see the thread now. The server sends them
  with the page (`ChatThreadPage.people`, `chat/threads.ts threadPeople`). They are the chat's audience
  (`Audiences.ofChat`: a project chat's project audience, a people-shared chat's creator and its people and groups,
  a guest only where the chat's audience holds them), without anyone the answer is hidden from, and never the caller.
  The list comes only while the caller may reply. The box is the rooms' mention box (TokenTextarea + useMentionMenu,
  no "@everyone"). A picked name is one token, and the reply goes with its ids.
- **The server decides:** a send keeps a mention only when the person is among `threadPeople` at that moment and passes
  `threadAccess` for themselves. The server keeps each id once, in the order given, never the sender. Every other id is
  dropped without an error, as rooms do (`validMentions`). The client's list is never trusted. Stored as
  `chat_thread_replies.mentions` (migration 417).
- **Shown:** a reply shows its mentions as names in the rooms' mention look (`lib/rooms.ts mentionClass`, mine on the
  soft background). The name opens the person's card. A reply's words stay plain text (never Markdown).
- **Notified:** a mentioned person follows the thread from that reply on, as a room thread's mention does. Their read
  mark starts before that reply, so the unread dot and later replies follow the existing thread rules. Someone who
  already follows keeps their read mark. They get the thread's one notice. It records the mention
  (`chat_thread_notices.mention_id`), and the Inbox row says "{name} mentioned you in a thread in {title}." while that
  reply is still there. Without the reply, the row is a plain reply notice again. The push is the existing thread push:
  the generic words, after 10 seconds, only while "Replies in threads I'm part of" is on and outside quiet hours, and a
  tap opens `/c/<chat>/t/<answer>`.
- **Why:** the owner wants to tag the people of the project. The one gate (`threadAccess`) and the one audience
  (`Audiences.ofChat`) already decide who sees a thread, so mentions reuse them and keep no second list. Reusing the
  thread notice keeps one notice per thread and person, and the push needs no change to the push gateway, the service
  worker or the phone apps.
- **Not added (lean):** mentions in the shared chat's main box (messages to the AI). That box is another component, its
  messages are AI turns in `messages`, and mentions there would need their own storage, rendering, prompt rules and
  notices. A push of its own ("mentioned you"), which would need the gateway and the apps. "@everyone" in threads.
  Editing a reply.
- **Privacy:** the picker shows a person who sees the chat the names of everyone else who sees it now. The thread already
  shows who replied. A group's member list stays hidden as before, because only people are listed, never which group
  let them in.
- **Tests:** `tests/unit/b-chat-thread-mentions.test.ts` (people list, outsider, self, made-up id, hidden answer and
  removed person dropped, follow, notice and Inbox row, push setting), `tests/unit/a-guests-chat-threads.test.ts`
  (guests), `web/test/unit/chat-thread-mentions.test.tsx` (picker list, token, sent ids, rendering),
  `web/test/e2e/chat-threads.spec.ts` (picker at 1440 and 390).
- **Version impact:** minor (a new feature, an additive migration readable by older builds).
