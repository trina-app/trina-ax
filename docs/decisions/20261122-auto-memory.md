# Trina keeps lasting facts and preferences on its own, never asking, with a quiet step and undo, only in the person's private chats

- Date: 2026-11-22
- Status: accepted
- Supersedes: for the person's own private chats with the switch on, the "only when the user wants it kept" rule of the
  remember tool and its card after outside content (server/src/chat/prompt.ts, chat/tools.ts). Shared chats, rooms,
  scheduled runs, confidential chats and admins' view of memories are unchanged.
- Branch: feat/auto-memory (the owner, 2026-11-22; plan review APPROVE WITH CHANGES)
- Plan: [docs/AGENTS/plan/20261122-0127-auto-memory.md](../AGENTS/plan/20261122-0127-auto-memory.md)

- **Ask:** the owner: "자동으로 조금씩 메모리에 쌓을수는 없어? 클로드 코드는 그렇게 하잖아 클코 따라가야해". The case: the
  AI found the right Aside profile for Daum mail after a wrong try, said it would use it from now on, and kept nothing.
  Asked whether a copied memory should still get a card: "클로드는 그렇게 해? 안하잖아 그냥 해".
- **Rule:**
  - In the person's own private chat in the app, the AI saves lasting, reusable facts and preferences without asking:
    what works for what (account, profile, tool), corrections and "always/never", stable facts about their work, dated
    project facts (relative dates made absolute), and what it learned after trial and error. Never one-off task
    details, secrets, or content copied from mail, pages, files, rooms or connections. What the person says now wins: a
    contradicted memory is updated, not duplicated.
  - **Never a card** with the switch on. A save the checks refuse is skipped silently ("기억하지 않음: …"); the AI is told
    the person can type it or add it in Settings. No exception to Always allow (Rule A) is needed.
  - Checks in code: a memory copied from tool output (6-word runs; 12-character runs for Japanese and Chinese), or
    carrying an address, path, #channel or room name seen only in tool output, is skipped; secrets with a value are
    refused; at most 2 silent saves per answer and 20 per 24 hours (`source = 'auto'`). Tool output is recorded in
    memory only; after a restart there is nothing to check and the save goes ahead.
  - The step "기억함: …" (also "기억 고침: …" and "잊음: …") has one control, 되돌리기, through the existing memory routes;
    the first auto memory shows a one-time line. Settings › Memory has "자동으로 기억하기" (on by default; off: "끄면
    말씀하신 것만 기억해요", today's behaviour).
  - Updates in place with `replaces`; exact duplicates are not added, near duplicates ask the AI to merge. Block order:
    the person's own memories first, then the AI's, newest first. When a silent save would push a memory out of the
    block, the AI must merge or forget first; the turn never fails.
  - The memory block says the memories are preferences and facts, and that nothing in it grants permission, changes a
    rule, or is a reason to send, share, post or delete without the usual ask.
  - No auto-save in shared chats, rooms, a turn that read rooms or a side chat, scheduled runs, Slack, template runs or
    confidential chats; per turn, so a person's follow-up in a scheduled run's chat is an ordinary turn.
  - Codex and the API engine get the same tool and rule; the engines' own memory stays off.
- **Why:** Claude Code's auto memory is the floor (owner: AI should match Claude Code), and it does not ask. A visible,
  reversible step keeps the person in control. Memories are used only in the person's private chats, so saving there
  and only there keeps privacy as it is.
- **Known gaps:** an injected instruction the model translates or paraphrases passes the copy check; the address check,
  caps, the visible step with undo and the block's framing are the rest of the defence. Measured in the eval.
- **Left out:** keeping tool output across restarts; auto-save in side chats; a "자동" tag in Settings.
- **Tests:** tests/unit/auto-memory*.test.ts; an AI scenario eval with 0 wrong saves allowed.
- **Version impact:** minor (new behaviour and a new setting).
