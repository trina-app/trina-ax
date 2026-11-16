# Teammates talk under an AI answer in a shared chat; the AI reads it only when someone sends it

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/chat-answer-threads (the owner: "go with your recommendations", after a plan and an independent review)

Plan: docs/AGENTS/plan/20261116-0351-chat-answer-threads.md (the planner's draft with the review's changes merged in).

- **Ask:** in a shared chat, teammates talk briefly under one AI answer ("Corporate seal, or the CEO line?") without the
  AI, then hand the result back to it.
- **Rule:** a finished answer (`done` or `stopped`) of a shared chat (a team project's chat or one shared with people
  and groups) gets "Reply in thread"; the thread opens beside the chat at `/c/:chatId/t/:messageId` (the whole screen on
  a phone), with the rooms' look (the thread line is one shared component). Replies are people's words only, in their
  own tables (migration 408). Who sees a thread is who sees the chat and the answer now: one gate,
  `server/src/chat/threads.ts threadAccess` on top of `chatFor` and the hidden-answer check, for every route, notice,
  Inbox row, push, realtime event and replay; everyone else gets the 404 of a missing thread. A private chat, a room's
  ✦ side chat, an answer still being written, one that failed or one hidden from the person has none.
- **Send to Trina fills the box, it never sends.** The thread goes into the chat's box as a Markdown quote: every line
  `> `, names on one line, the newest replies within 4,000 characters, a line saying older ones were left out, and not
  the answer's own text (`shared chats.ts chatThreadDraft`). The person edits and sends it as their own question, so the
  turn's gates read it as other people's words (`readRooms` cards for deletes, skills and memory; `ownWords` keeps quoted
  names red; links in quotes are not "typed by the person"). Offered only where that box can send it now: the chat can be
  continued (not in the trash, not read-only, safe mode off), the person's AI is on, no answer of theirs runs, there are
  replies, and the answer is on the version the chat shows.
- **Followers and notices:** the answer's asker and everyone who replied. One unread notice per thread and person,
  updated in place by later replies; the push waits 10 seconds (someone looking at the thread reads it first) and says
  only "Someone replied in a thread."; it follows the existing "Replies in threads I'm part of" setting (its description
  now names shared chats); the Inbox row comes either way, read live: who and which chat while the person still sees it,
  "You can't see this anymore" otherwise. A notice whose reply was deleted goes with it.
- **Delete:** the author, or whoever moderates the chat (a project chat: its creator or a project editor; a chat shared
  with people: its creator), with a confirm and no undo; a moderator's delete is audited with ids only.
- **Limits:** 10,000 characters a reply, 500 replies a thread (409 `thread_full`), the rooms' sending budget (429 with
  `retryAfter`), the same `clientId` posts once.
- **Search and export:** replies are not searched (⌘K) and not in the owner's export yet.
- **Account removal:** a removed person's replies stay under their tombstone name, also when they asked for deletion (one
  rule with room messages; the delete page says so); what they follow and their notices go.
- **Why:** the AI must never see what people say among themselves unless one of them chooses to send it, and then as
  that person's own, visible, editable message. Storing replies in rooms or in `messages` would have put them in the AI's
  history, search and Often asked; a second copy of who sees a chat would drift from `chatFor`.
- **Not added (lean):** edit, mentions, reactions, files in replies, "Also send to the chat", a Threads view, chat-list
  unread, mute, AI summaries, a confirm step in Share, a counter in the version switch, a teaser in private chats.
  P2: export, "Show it in the chat" for another version, the Members dialog line, a "server updating" line of its own,
  edit, mentions, search, the iPhone label with a name, the "From a thread" chip.
- **Tests:** `tests/unit/b-chat-threads.test.ts` (gate, replies, notices, push, delete, replay, the AI-isolation marker,
  the draft read as quotes), `tests/unit/a-guests-chat-threads.test.ts`, the permission matrix cases and the shared-chat
  security tables, `web/test/unit/chat-threads.test.tsx`, `web/test/e2e/chat-threads.spec.ts`.
- **Version impact:** minor (a new feature, four endpoints, an additive migration readable by older builds).
