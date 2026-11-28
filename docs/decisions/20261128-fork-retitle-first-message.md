# A continued chat is named by its first new message, as a new chat is by its first question

- Date: 2026-11-28
- Status: accepted
- Supersedes: the title part ("renamed as any chat") of [Continue in a new chat](20261126-chat-fork-tree.md)
- Branch: fix/fork-retitle-first-message (the owner, 2026-11-28; plan
  [20261128-1542-fork-retitle-first-message](../AGENTS/plan/20261128-1542-fork-retitle-first-message.md))

- **Ask:** the owner showed three continuations of one shared chat in the history, all "안녕하세요, 트리숲 … (이어서)", and
  could not tell them apart. Recommended: rename a continuation by itself after its first message; the owner: "ㅇㅇ".
- **Rule:**
  - A continuation is made with "<원래 제목> (이어서)" / "<title> (continued)" and `chats.title_source = 'fork'`, so the
    row is recognisable before anything is asked in it.
  - Its first new message names it as a new chat's first message does: that message's placeholder replaces the whole
    title (the "(이어서)" goes; nothing to make a placeholder of keeps it), the source becomes 'auto', and the answering
    AI may call set_title in the chat's first two messages of its own (copied messages, `messages.fork_copy = 1`, do not
    count). The same tool for Claude Code, Codex and the API engine. The rule for the AI: the title says what the person
    asks in the new message; the carried messages are context only.
  - A rename by the person ('user') ends it for good, before or after the first message, as for any chat, also one that
    lands while the first message is still being sent (the send keeps the title the row has then, not the one it read
    before its uploads).
  - Regenerating a copied answer is not a message of its own: no placeholder and no set_title until the first new one.
  - The line "‘<원래 제목>’에서 이어 왔어요" keeps the original's title (`chats.fork_title`), and the history keeps the row
    under its original (`chats.fork_parent`, `Chat.forkParents`): neither reads the title.
- **Why:** the title is what tells rows apart; the original's name is kept by the line back and the indent.
- **Left out:** continuations made before this change keep their titles (a rename fixes one). No migration:
  `title_source` is free text, and an older build reads 'fork' as a title it never renames.
- **Tests:** tests/unit/b-chat-titles.test.ts (a continuation's first message, the live update keeping forkParents, a
  greeting then the second message, a renamed continuation, a rename during the first send, a regenerated copied answer, Codex).
- **Version impact:** patch (a fix to how an existing feature names its chats).
