# Shared chats keep each person's own engine session

- Date (UTC): 2026-11-23 02:54
- Branch: `fix/shared-chat-resume`
- Status: in progress
- Where: server/src/chat (turn.ts, shared.ts, runtime.ts, prompt.ts), server/src/admin/folders.ts. Why: the engine session is chat runtime (docs/REPOSITORY-RULES.md)
- Version impact: patch (a fix: shared chats stop starting a fresh engine session every turn; no schema or API change)

## Goal

The owner: "세션 그대로 가져가야할 것 같은데.. 지금 세션이 하나인것처럼 보이는데, 그게 안되니깐 너무 아이러니인데".
In a shared or project chat, once a turn read something not everyone there may open (a personal folder file after the
read card's yes, a connection only some use), every later turn started a fresh Claude Code session
(`turn.ts` `scopeHiddenFromAudience`, and `stashWrittenBy`: only the person who wrote the last answer resumes). A fresh
session re-sends the whole history and misses the prompt cache, and it forgets the tool results. Subscription users
burn their rate limit faster, API-key users pay more, and the AI forgets what it did.

## Scope

In:
- One engine session per person per chat in shared chats (the person's own session goes on after other people's
  turns; what they wrote since comes with the message as a `<since_your_last_answer>` block, as that person may see it).
- The resume no longer stops on "the chat read something some here cannot open". Protection moves to the answer:
  the resumed answer's record carries what the session holds (k groups as they were, y groups as they were, and every
  other read goes through the read card again when someone who sees the chat now may not open it).
- Resets: a person whose access shrinks loses their sessions in every shared chat (not only the chat whose last answer
  was theirs); the stash keeps every other person's newest session.
- The step records of #409 stay as the fallback for a fresh session.

Out: Codex and the API engine (they start fresh every turn, as before); one session shared by everyone (rejected below).

## Steps

1. `shared.ts`: `ownSessionOn` (the person's newest stashed turn on this branch, its file, the answers in it),
   `othersSessionFiles`.
2. `turn.ts`: the shared-chat resume decision; `sessionHeld`; the since block in a resumed message; stash keeps others'.
3. `prompt.ts`: `sinceOwnBlock` (window-bounded; too long → fresh session with the summary).
4. `runtime.ts` / `admin/folders.ts`: `SESSION_CHATS_OF` for resets and counts; blobs cleared on reset.
5. Tests in `tests/unit/b-shared-chats.test.ts`; fake engine ignores directives quoted in the since block.
6. Measure tokens before/after on a QA copy (claude-code, QA token).

## Decisions

docs/decisions/20261123-shared-chat-own-session.md

## Result

(filled at the end)
