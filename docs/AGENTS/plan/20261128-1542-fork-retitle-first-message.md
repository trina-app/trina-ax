# A continued chat gets its own title from its first new message

- Date (UTC): 2026-11-28 15:42
- Branch: `fix/fork-retitle-first-message`
- Status: done
- Where: server/src/chat (title.ts, fork.ts, runtime.ts, prompt.ts). Why: chat titles and forks live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to how an existing feature names its chats; no new API, no migration

## Goal

The owner showed three continuations ("새 채팅에서 이어 하기") of one shared chat, all reading "안녕하세요, 트리숲 … (이어서)":
nobody can tell them apart. A continuation now gets a title of its own from its first new message, the same way a new
chat does from its first question. The owner agreed ("ㅇㅇ", 2026-11-28).

## Scope

In:
- A continuation is made with `chats.title_source = 'fork'` (new value; it was the original's source, 'auto' became
  'ai', so it was never named again). Its title stays "<original> (이어서)" until its first new message.
- Its first new message: the placeholder of that message replaces the whole title (no "(이어서)" kept) and the source
  becomes 'auto', as a new chat's first message. A message with nothing to make a placeholder of keeps the title and
  'fork'.
- set_title is offered as for a new chat: while the source is 'auto' or 'fork', in the chat's first two messages, where
  copied messages (messages.fork_copy = 1) do not count. Same tool for Claude Code, Codex and the API engine.
  TITLE_RULE says the title is about the new message, not the carried conversation.
- A rename by the person ('user') ends it for good, as for any chat.
- Unchanged: the line "‘<original>’에서 이어 왔어요" (chats.fork_title), the history tree (chats.fork_parent, forkParents).

Out: renaming continuations made before this change (they keep their titles; a rename fixes them).

## Steps

1. This plan.
2. fork.ts: insert 'fork'. title.ts: 'fork' in titleToolOffered / setAiTitle, count only new user messages; comment.
3. runtime.ts: the first new message replaces a 'fork' title with its placeholder and sets 'auto'.
4. prompt.ts TITLE_RULE: one sentence for a chat that starts with carried messages.
5. Tests, decision file, changes note.

## Decisions

New: docs/decisions/20261128-fork-retitle-first-message.md. It changes the title rule of
[Continue in a new chat](../../decisions/20261126-chat-fork-tree.md) ("renamed as any chat").

## Risks

No migration (title_source is free text). Old builds read 'fork' as a non-automatic source (never renamed): safe on a
rollback. Shared-chat set_title rules unchanged (a continuation is private). Six languages: no new strings; the
placeholder is the person's own words.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`; unit: b-chat-titles (new
continuation cases: title after the first message, live chat.updated keeps forkParents, renamed kept, nothing before the
first message, Codex), b-chat-fork, b-chat-fork-tree, b-fork-in-history; tests/security fork tests; web unit; web e2e
chat-fork under Bun 1.3.12.

## Result

Built as planned. The placeholder swap is a separate guarded update (`WHERE title_source = 'fork'`), so a rename that
lands while the message is admitted wins. The web mock (test/mock/server.ts) names a continuation on its first message
too, and chat-fork-tree.spec checks the row's title changes live with its "└" and the line back kept. b-chat-fork-tree's
detach test now expects the renamed first continuation ("More") and one "(continued)" on its continuation.
