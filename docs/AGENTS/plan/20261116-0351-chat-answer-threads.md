# Threads on AI answers in shared chats (P1)

- Date (UTC): 2026-11-16 03:51
- Branch: `feat/chat-answer-threads`
- Status: done
- Where: trina-ax core: `server/src/chat`, `server/src/notifications`, `shared/src/api`, `web/src/components/chat`,
  `push-gateway/src/text.ts`. Why: chats, permissions and notifications go into the core first
  (docs/REPOSITORY-RULES.md). 넣을 곳: trina-ax 코어 (server/src/chat, shared/src/api, web/src/components/chat), 이유:
  채팅·권한·알림 기능은 코어에 먼저 넣는다.
- Version impact: **minor**. A new feature, four endpoints, one additive migration an older build can still read
  (reader level 1).
- Inputs: the planner's draft and an independent review (2026-11-16). Where they disagreed the review won; its changes
  are merged in below and its answers are in "Open questions: decided". The owner approved ("go with your
  recommendations").

## 1. Goal

In a shared chat (a team project's chat, or a chat shared with people or groups), teammates talk briefly under one AI
answer ("Corporate seal, or 대표 남대현 (인)?"). The AI is not part of that talk. When they have settled it, one of
them presses **Send to Trina**: the talk lands in the chat's box as a quote, and they send it as their own question.

## 2. Direction

| # | Proposal | Verdict | Why |
|---|---|---|---|
| 1 | Reuse the rooms' thread UI and data | UI yes, data no | Who sees a chat is worked out live (`chat/shared.ts` `chatFor`, `Audiences`); a hidden room per chat would be a second source of truth. `room_messages` and `messages` are read by search, the AI's history, the room AI's tools, export, Often asked and titles. So: new tables; the look is the rooms' (`ThreadLine`, column, divider, stick-to-bottom, skeletons). |
| 2 | People only | Keep | No AI path reads the new tables. |
| 3 | "Send to Trina" posts the result | Fill the box, don't send | The presser decides what the result is; a draft they edit and send is explicit and can be undone; no new endpoint. |
| 4 | "3 replies · names"; notify participants | Keep, as rooms do | Followers: the answer's asker and everyone who replied. Not the chat's whole audience. |
| 5 | Shared chats only | Keep | Needs `Chat.shared`. Private chats, the room ✦ side chat, confidential and scheduled-run chats get no button. |
| 6 | No AI in threads | Keep | No @Trina in a thread. |

## 3. Data model: `server/migrations/408_b_chat_answer_threads.sql`

`-- min_compatible_reader: 1`. Only new tables; an older build ignores them, and after a rollback threads are invisible
but nothing leaks (only the new code reads them). 408 is in B's range; 407 is held by #1038 (being renumbered into C's
range). Re-check `git ls-tree origin/dev server/migrations/` and open PRs before pushing.

- `chat_thread_replies(id uuidv7 PK, chat_id → chats CASCADE, root_id → messages CASCADE, author_id (no FK: a removed
  account keeps its tombstone name, like messages.author_id), content, client_id, created_at)`; index `(root_id, id)`,
  unique `(author_id, client_id) WHERE client_id IS NOT NULL`, index `(author_id)`.
- `chat_thread_follows(root_id → messages CASCADE, user_id → users CASCADE, chat_id → chats CASCADE, last_read_id,
  created_at, PK(root_id, user_id))`; index `(user_id, chat_id)`.
- `chat_thread_notices` (review M4: not a copy of `chat_answer_notices`): `id, user_id → users CASCADE, event_type
  CHECK IN ('chat.thread_reply'), source_id` (= the thread's answer id, so the Inbox union reads it like every notice
  table)`, chat_id, by_user` (the newest replier)`, reply_id` (the newest reply)`, created_at, push_at, read_at,
  suppressed`; a partial unique index `(user_id, source_id) WHERE read_at IS NULL`: one unread notice per thread and
  person. A reply updates the open row in place (`by_user`, `reply_id`; not `created_at`), so the push stays "one per
  unread thread"; once read, the next reply makes a new row and a new push.
- `chat_thread_push_deliveries`: the same columns as `chat_answer_push_deliveries`.
- **No** `notification_preferences` column (Q4: the existing thread setting is reused).
- A deleted reply's row goes (no tombstone, no undo). No edit, no reactions in P1. Purging a chat removes its replies by
  cascade; the trash keeps them.
- At most 500 replies per thread (409 `thread_full`); a reply is at most `ROOM_MESSAGE_MAX` (10,000) characters.

## 4. APIs (`shared/src/api/chats.ts`, owner B) and `docs/features.ts`

| Name | Method and path | Notes |
|---|---|---|
| `listChatThread` | `GET /api/chats/:id/messages/:messageId/thread?cursor&limit=50` | `{ root: Message, replies, nextCursor, canReply, readOnlyReason?: 'safe_ops' \| 'trash' \| 'not_shared', version: {index, count}, onShownBranch }`. `root` is built with `messageFor(... view)` (M2). |
| `sendChatThreadReply` | `POST /api/chats/:id/messages/:messageId/thread` `{ text, clientId }` | 201 `ChatThreadReply`. The gate first, then the room sending budget (429 `retryAfter`) (L5). A duplicate `clientId` answers with the existing reply. The root: an assistant message of this chat, `done` or `stopped` (Q16), not hidden from the sender. |
| `deleteChatThreadReply` | `DELETE /api/chats/:id/thread-replies/:replyId` | 204. The author, or for a project chat its creator or a project editor, for a people-shared chat its creator (Q13); audited with ids only. `reply.chat_id` must be `:id`. |
| `markChatThreadRead` | `POST /api/chats/:id/messages/:messageId/thread/read` `{ upTo }` | 204. Never past the newest reply of that thread. |

- `Message.thread?: { replyCount, lastReplyAt, repliers: UserRef[≤3], newReplies }` rides on `listMessages`.
- Send to Trina adds no endpoint: it fills the box; `sendMessage` sends it.
- `docs/features.ts`: `chat.threads` with the four endpoints and the screen `/c/:chatId/t/:messageId`; then
  `bun run features:check` and `bun run docs:api`.
- The four endpoints go on the guest allow-list (`server/src/auth/guest-endpoints.ts`) on purpose; the gate is the
  real check (M3).

## 5. Permissions

One gate, `threadAccess(rt, userId, chatId, rootId, 'view' | 'post')`, in `server/src/chat/threads.ts`:

1. `chatFor(rt, userId, chatId, view ? 'view' : 'continue')`: guests (only their own shared chat), `no_longer_member`,
   `no_longer_shared`, a project in the trash, a deleted chat, and 409 `safe_ops` for posting.
2. Posting needs `isSharedRow`. A chat that stopped being shared but has others' messages stays readable to its creator
   and is closed to new replies (`readOnlyReason: 'not_shared'`).
3. The root is an assistant message of that chat and not withheld: `messageView(...)?.withheld(id) ?? false` (a chat
   of one person has no view, M2). Otherwise the same 404 as a missing thread.
4. Every read, post, notice (at creation too, M6), Inbox row (H2), push, realtime event and replay (M1) goes through the
   gate. No cached audience. Every query filters by `chat_id` and `root_id`.

| Role | Read | Post | Delete own | Delete others' | Send to Trina |
|---|---|---|---|---|---|
| Owner/admin who sees the chat | yes | yes | yes | project chat: if project editor or creator; people chat: if creator | while the box can send (M8) |
| Owner/admin who doesn't see it | 404 | 404 | – | – | – |
| Member who sees it | yes | yes | yes | if creator or project editor | while the box can send |
| Guest, own chat | yes | yes | yes | if creator | while the box can send (AI on) |
| Guest, anyone else's chat | 404 | 404 | – | – | – |
| Removed mid-thread | 404 with the chat's reason | blocked | – | – | – |

Audience changes need no new code: `chat/people-share.ts` (`putChatAudience` removal) and `admin/folders.ts`
(`afterAccessChange`) already send `chat.updated {change: 'deleted'}`; the web closes the thread with the chat. Follow
rows stay; notices, Inbox rows and pushes re-check the gate.

## 6. Interactions

**Realtime.** `chat.thread {chatId, rootId, change: 'reply' | 'deleted' | 'read', reply?, replyId?, thread}` per person
through `Audiences.ofChat(r)` (the creator too when the chat is unshared, so a delete reaches them), leaving out anyone
the root is hidden from (`AnswerSight`, with the fast path for an answer nobody is hidden from, L4). Each person's own
`newReplies`. `hub.ts stillVisible` re-checks `threadAccess(view)` before a replay; otherwise `resync` (M1). A read on
one device sends `change: 'read'` to that person's other windows.

**Notifications and push.**
- A reply notifies followers other than the author, while the gate holds for them (M6): one unread notice per thread
  and person, updated in place.
- Registered in: `NotificationEventType` (`chat.thread_reply`), `PushEventType`, `tableOf`, `NOTICE_TABLES`, a
  `noticeOut` branch with a live access check (title through `redactorFor(...).hide` and `plainLabel`; no access → no
  name, title or link), `cancelDisabledPushDeliveries`, `pushPaths` (`/c/<chat>/t/<root>`), push SOURCES,
  `server/src/notifications/text.ts` and `push-gateway/src/text.ts` (H2).
- Push waits `push_at` (short delay, `due: 'MAX(?,n.push_at)'`), so a reader with the thread on screen marks it read
  first (M4). Lines: en "Someone replied in a thread." / ko "스레드에 답글이 달렸어요." No name, title or text. An older
  gateway falls back to its generic line.
- `chatThreadWanted`: unread, an unread reply still exists (M5), "Replies in threads I'm part of" on, outside quiet
  hours, the gate holds. A delete that leaves a notice with no unread reply marks it read and cancels its deliveries.
- Setting: the existing "Replies in threads I'm part of" (`roomThreadReplies`), with a wider description (Q4). Off: no
  push; the Inbox row still comes.
- A chat hidden with "Hide from my list" still notifies its followers.

**Share note.** `chat.share.note` / `noteShort`: "Everyone here sees the whole chat, its threads included, …". The
Members dialog line moves to P2.

**Search.** Not indexed in P1; ⌘K doesn't find replies (decision file says so).

**Export.** P2: the export doesn't include threads yet (decision file says so).

**Account removal.** `chat_thread_follows.user_id`, `chat_thread_notices.user_id` in `chat/account-cleanup.ts`;
`chat_thread_replies.author_id` in `USER_COLUMNS_WITHOUT_FK` and `KEPT_WITH_ACCOUNT` (replies stay under the tombstone
name, also on a self-requested deletion: one rule with `room_messages.author_id`, Q6). The delete page's line names
replies.

**Versions.** A thread belongs to one answer version (its message id). After a regenerate or an edit the new version
has none; the old one keeps its own; the thread line shows under the version that has it. An open thread whose answer
isn't on the shown branch says "This thread is on another version of the answer (2 of 3)." with only ✕ (Q12), and Send
to Trina is hidden.

**Delete.** The rooms' confirm: "Delete this reply?" / "It's removed for everyone in this chat. This can't be undone."

**Phones.** Below 768 px the thread is full screen at `/c/:chatId/t/:messageId`: 48 px bar with ‹, tabs hidden, the box
above the keyboard, 44 px targets. A tapped push opens the thread route. The rail, the Projects highlight, ⌘K scoping
and `Layout besideThread` learn the thread route (L1).

**✦ side chat in rooms.** No button (never shared); a web test checks `sideChat` never renders it.

**The AI's context.** Nothing reads `chat_thread_*` in prompts, `labelledTranscript`, the room AI's tools, MCP,
connectors, Often asked, titles, memories or schedules. The only way in is Send to Trina, as the presser's own message.
A server test puts a marker in a reply and checks it is in no AI input.

## 7. UX (Slack-style, plain words, en first)

**Entry.** On a finished answer in a shared chat: "Reply in thread" (lucide `MessageSquareReply`, not another plain
bubble: L3) in the action row. Under an answer with replies: up to 3 faces, "3 replies", "· last reply 2:10 PM"; a dot
and "New replies" for a follower with unread ones (the rooms' `ThreadLine`, made a shared component).

**Panel.** Header "Thread" and ✕ (Esc). The answer on top (clamped, "Show more"), a hairline with "n replies", the
replies (face, name, time, text with safe links), the box "Reply…", and one grey line: "Only people in this chat see
replies. Trina reads them only when someone sends them to Trina." (M9). Footer: "Send to Trina" (ghost) with "You can
edit it before sending." A reply's menu: Copy, Delete (when allowed).

**Send to Trina (H1, L6, L7).** Fills the chat's box, below anything already there, with:

```
> Thread on Trina's answer · 2:10 PM · 4 replies
> Minji · 2:11 PM
> Corporate seal, or 대표 남대현 (인)?
> Jae · 2:12 PM
> Seal. Legal said so last time.

```

Every line quoted, names made one line (`oneLineName`), newest replies kept within 4,000 characters (`SEED_QUOTE_MAX`)
with "> …(earlier replies left out)" on top when cut. The answer's own text is not quoted. The box gets focus; on a
phone the thread closes back to the chat. Hidden (M8) when: the box can't send (safe mode, not shared now, in the trash,
no AI for the person), no replies, or the thread's answer isn't on the shown branch.

| State | en | Way out |
|---|---|---|
| Empty | the answer, "No replies yet", box focused, the "Only people…" line | ✕, Esc, ‹ |
| Loading | skeleton rows | ✕ |
| Load failed | the error with Retry; the connection banner as elsewhere | retry |
| Offline while sending | faint reply "Not sent · Send again", text kept | Send again (`clientId`: once) |
| Server updating | the existing `conn.updating` banner and `conn.unsent` | send again |
| Lost access | the chat's own screen ("no longer shared with you" / "no longer in {project}") | Home |
| Gone / trash for a follower | "You can't see this thread. It may have been deleted." (M7) | ✕ |
| Another version shown | "This thread is on another version of the answer (2 of 3)." | ✕ |
| Read-only: safe mode | the existing safe-mode line in place of the box | ✕ |
| Read-only: not shared now | "This chat isn't shared anymore, so no new replies." | ✕ |
| Long thread | 50 a page, older on scroll up; at 500: "This thread is full. Continue in the chat." | ✕ |
| Too long | Send off past 10,000; "This reply is too long." | edit |
| Empty reply | Send off | – |
| Rate limited | "You're sending fast. Try again in a moment." then it sends by itself | – |

Roles look the same; Delete on others' replies only for whoever may moderate. 1440: a column beside the chat (the
chat keeps its width; resizable; opening a file or artifact closes the thread, opening a thread closes the panel). 390:
full screen. Light and dark: tokens only. Six languages: en, ko (해요체), id, ja, es, zh.

## 8. Not added (lean)

Edit, mentions, reactions, files in replies, "Also send to the chat", a Threads view, chat-list unread, per-thread mute,
search, AI summaries, a confirm step in Share, a counter in the version switcher, a disabled button or teaser in
private chats.

## 9. Open questions: decided (the review's answers; do not ask the owner again)

| # | Question | Answer |
|---|---|---|
| Q1 | Where replies live | New tables |
| Q2 | Send or fill | Fill the box, quoted format |
| Q3 | Draft cap | 4,000, newest kept |
| Q4 | New setting | No: reuse "Replies in threads I'm part of" with a wider description; no new column |
| Q5 | Followers | The answer's asker and everyone who replied |
| Q6 | A removed account's replies | Stay under the tombstone name, also on a self-requested deletion |
| Q7 | Deleted reply | Gone, no undo |
| Q8 | Cap | 500, 409 `thread_full` |
| Q9 | Search | P2 |
| Q10 | Locales | All six |
| Q11 | Export | P2 |
| Q12 | Another version shown | A line and ✕; Send to Trina hidden; the button in P2 |
| Q13 | Moderator delete | Creator or project editor (project chat); creator (people chat) |
| Q14 | App icon number | Unchanged |
| Q15 | Trash for followers | The plain "can't see this thread" |
| Q16 | Error answers | No threads: `done` and `stopped` only |

## 10. Phasing

- **P1 (this branch):** migration 408; `chat/threads.ts`; 4 routes; `Message.thread`; `chat.thread` with
  `stillVisible`; notices, Inbox, push under the existing setting; gateway text; the panel and the route; Send to Trina
  quoted; delete with moderation; Share note wording; account cleanup; tests and screenshots.
- **P2:** export of threads; "Show it in the chat" on another version; the Members dialog line; a special "server
  updating" line; edit; @mentions; ⌘K search; unread in the chat list and Activity; the iPhone label with a name; a mark
  on "‹ 2/3 ›"; a "From a thread" chip; counts in the Share dialog.
- **P3 (owner decides):** "Summarize for Trina" (the first AI read of thread text: its own decision).

## Decisions

`docs/decisions/20261116-chat-answer-threads.md` (not `docs/DECISIONS.md`).

## Risks

- Migration number races (408; check right before pushing). #1038 also edits `notifications/service.ts`.
- Permissions: one gate, tests for every route in the permission matrix and route coverage, guests, removal mid-thread,
  replay, Inbox.
- The AI's context: the marker test; Send to Trina quoted so `readRooms()` and `ownWords()` treat it as others' words.

## Tests

- Server: `tests/unit/b-chat-threads.test.ts` (gate, store, notices, push, replay, draft quoting, AI isolation marker),
  permission matrix, route coverage, guest endpoints, account removal, migration ranges.
- Web: unit (draft builder, rail, side chat has no button), e2e `chat-threads.spec.ts` with the chat-share specs,
  screenshots `shots-chat-threads.spec.ts` (owner, admin, member, guest × 1440 / 390 × light / dark × en / ko).
- Checks: `bun run typecheck`, `check:i18n`, `check:docs`, `features:check`, server tests for chat, notifications, push
  and security under Bun 1.3.12, web unit tests, targeted e2e.

## Result

Built as planned (P1, the review's scope). Differences:

- The notice table keeps the column name `source_id` for the thread's answer (the Inbox reads every notice table
  through one union of `id, user_id, event_type, source_id, created_at, read_at, suppressed`); the partial unique index
  is `(user_id, source_id) WHERE read_at IS NULL`.
- The realtime fan-out works out who the answer is hidden from with `AnswerSight` per event; the review's fast path for
  answers nobody is hidden from (L4) is left for later (cost only, not access).
- A deleted reply's last unread notice is removed (not only marked read), so its Inbox row goes and its pushes with it.
- The web service worker learned the new push code (its click opens the thread from the signed-in notice).
- Not changed in P1: the Members dialog line, export, "Show it in the chat", the iPhone label.

PR: see the branch's pull request to dev.
