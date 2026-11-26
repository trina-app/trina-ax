# "Continue in a new chat" from any chat of mine, under the chat it came from in the Trina history

- Date: 2026-11-26
- Status: accepted
- Supersedes: decision 1 (entry point A, only the shared chat's title menu) and the item's label of [Chat fork](20261126-chat-fork.md)
- Branch: feat/chat-fork-tree (the owner's team chat, 2026-11-26, then an independent UX review for people who are not
  developers; plan [20261126-1013-chat-fork-tree](../AGENTS/plan/20261126-1013-chat-fork-tree.md))

- **Ask:** the team looked at the Claude desktop app's session list (forks under their parent, a fork of a fork, "Fork"
  and "Detach to top level" in the row menu). The owner: "then we can fork from forked session too? like a tree?" and
  "we can make forked session become root". A UX review then found a real tree too much for people who are not
  developers, and #641's result unclear after the click.
- **Rule:**
  - **Words, never "fork" / "포크":** my own chat "새 채팅에서 이어 하기" / "Continue in a new chat"; a shared chat "나만 보는
    새 채팅에서 이어 하기" / "Continue in a new chat only you see" (the AI quotes this one: chat/prompt.ts `privatelyMenu`,
    policy/refusal.ts). In the chat title's "···" and the history row's "···" (and its long-press sheet); hidden where the
    server refuses (a room's side chat, a scheduled run, a confidential chat or safe operations, the trash, a guest
    outside their project or without AI; the title menu also until an answer has finished there).
  - **The new chat says what it is:** its title is "<원래 제목> (이어서)" / "<title> (continued)" (once: a continuation of a
    continuation keeps one), renamed as any chat. The line at the top stays ("‘제목’에서 이어 왔어요", a link), and the
    line under the box says "🔒 나만 보는 채팅 · ‘<제목>’에서 이어 왔어요. 원래 채팅은 그대로예요." with the title a link
    to the original (WhoSees.tsx; no new element). A project page's "나만 보는 채팅 N개 · 공유할 채팅 고르기" never counts
    these chats: they are private on purpose.
  - **What is copied:** `POST /api/chats/:id/fork` takes my own chat too (another person's chat of one person: 404).
    Everything on the branch, as #641 copies a shared chat with me as the only audience; copies stay copies in a
    continuation of a continuation (other people's names, a hidden answer's line, chat files by reference, the marks).
    My own computer uploads get rows of the new chat's own, so its pictures and a send again keep them after the
    original is purged. Its project: the chat's, while I still see it. The first answer resumes my copied Claude Code
    session as any chat of mine does, with the checks for me alone, and a note that it continues my chat.
  - **In the history, one level only:** a new chat sits indented once under the chat it came from; a continuation of a
    continuation sits at the same level, right under the first chat. No arrows, nothing folds. `chats.fork_parent`
    (migration 463) apart from `fork_of`; `Chat.forkParents` (nearest first, at most 8, for the chat's own person, ids
    only, never past a chat of someone else's). A row sits under the nearest of them that is a row of the same list and
    the same date group, else it is a row of its own: a chat deleted, hidden, pinned, in another section, filtered out,
    no longer mine or not loaded yet hands its continuations up. Purged from the trash, a chat hands them to its own
    parent.
  - **Order: every chat keeps its own place.** A group sits where its first chat sits by the list's sort; its
    continuations follow right under it. Using a continuation never lifts an older chat up (a continuation used today
    while its chat is from last week stands in Today on its own, as the date groups already say). Chosen over "the
    group at its newest row", which made old chats jump to the top when a continuation was used.
  - **"목록에서 따로 두기" / "Move out on its own":** `PATCH /api/chats/:id { forkParent: null }`, the chat's person only,
    audited `chat.fork_detach`. Only its place in my list changes: its last activity and its lines stay; nothing
    re-attaches.
- **Why:** the Claude app keeps a session's continuations with it, and Claude Code is the floor; but a deep tree with
  arrows reads as a developer tool, and the people here are not developers. One level and plain words keep the idea.
- **Left out:** trees under Group by Project (flat), a mark in flat lists (pins, a project page), an item per answer,
  moving a chat under another.
- **Tests:** tests/unit/b-chat-fork-tree.test.ts, tests/unit/b-chat-fork.test.ts, web/test/unit/fork-tree.test.ts,
  web/test/e2e/chat-fork-tree.spec.ts and chat-fork.spec.ts (1440 and 390, light and dark).
- **Version impact:** minor (a new user-visible feature, an optional field on Chat and on PATCH /api/chats/:id, one
  additive migration 463; older clients show these chats as plain rows).
