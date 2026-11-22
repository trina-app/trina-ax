# Trina keeps lasting facts and preferences on its own, with a quiet step and undo, only in the person's private chats

- Date: 2026-11-22
- Status: proposed
- Supersedes: for the person's own private chats with the switch on, the "only when the user wants it kept" rule of the
  remember tool (server/src/chat/prompt.ts, chat/tools.ts). Shared chats, rooms and admins' view of memories are
  unchanged.
- Branch: feat/auto-memory (the owner, 2026-11-22)
- Plan: [docs/AGENTS/plan/20261122-0127-auto-memory.md](../AGENTS/plan/20261122-0127-auto-memory.md)

- **Ask:** the owner: "자동으로 조금씩 메모리에 쌓을수는 없어? 클로드 코드는 그렇게 하잖아 클코 따라가야해". The case: the
  AI found the right Aside profile for Daum mail after a wrong try, said it would use it from now on, and kept nothing.
- **Rule:**
  - In the person's own private chat the AI saves lasting, reusable facts and preferences without a card: what works
    for what (account, profile, tool), corrections and "always/never", stable facts about their work, and what it learned
    after trial and error. Never one-off task details, secrets, or content copied from mail, pages, files, rooms or
    connections.
  - The turn shows one step "기억함: …" with undo and a link to Settings › Memory; the first one shows a one-time line
    saying so and how to turn it off.
  - It updates a memory (`replaces`) instead of adding a duplicate; exact duplicates are not added; a near duplicate asks
    the AI to merge. A full memory block never makes a save fail: the newest is kept and the AI is told which older ones
    no longer fit, to merge them.
  - A per-person switch in Settings › Memory, "자동으로 기억하기", on by default. Off is today's behaviour.
  - Not in shared chats, rooms, a room's side chat, scheduled runs, Slack or template runs.
  - Injection: an instruction in a tool result never creates a memory. In a chat with outside content, a memory whose
    words are copied from that content, or that carries an address seen only there, goes to the card (Always allow does
    not skip it); unknown outside content (after a restart) goes to the card; secrets are refused; at most 3 auto-saves
    per answer and 20 per day.
  - Codex and the API engine get the same tool and rule.
- **Why:** Claude Code's auto memory is the floor (owner: AI should match Claude Code). Saving quietly with a visible,
  reversible step keeps the person in control without a card on every lesson. Memories are used only in the person's
  private chats, so saving there and only there keeps privacy as it is.
- **Left out:** storing outside text across restarts (hashed shingles) until the card shows too often; auto-save from
  the person's own words in a room side chat.
- **Tests:** tests/unit auto-memory tests (no card, dedupe/update/undo, switch off, shared chat, secrets, injection from
  a mail body, restart, rate limit, full block); an 18-case AI scenario eval with 0 wrong saves allowed.
- **Version impact:** minor (new behaviour and a new setting).
