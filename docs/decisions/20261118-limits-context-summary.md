# A fresh session gets a summary of the older part of the chat

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "40,000 characters, no summary yet" part of "Long conversations: say when the AI got only the recent
  part" (docs/DECISIONS.md, 2026-10-30). Its note in the chat stays, for what no summary covers.
- Branch: fix/limits-context-summary (limits audit #3, QA TC-4905)

Plan: docs/AGENTS/plan/20261118-1000-limits-context-summary.md.

- **Ask:** a fresh engine session got only the last 40,000 characters of the chat text, with no file contents, no tool
  results and no summary. That is every Codex or API message, every edit or regenerate, each change of person in a
  shared chat, and every Claude session dropped at 20 MB (a few answers with pictures). The AI "forgot" what was said
  early on. Claude Code keeps the whole session and compacts it with a summary.
- **Rule, the window:** counted in estimated tokens, not characters: 4 ASCII characters or 1 other character per
  token, 40,000 tokens (`HISTORY_MAX_TOKENS`). That is 160,000 characters of English (was 40,000) and the same 40,000
  of Korean, so a Korean chat is not given more than before.
- **Rule, the summary:** what the window leaves out goes into a summary (`chat/history-summary.ts`), given at the top of
  `<previous_conversation>` with "Summary of the first N messages", then "The most recent messages, word for word".
  - One cheap model call: the file list's reader (`file-list/engine-reader.ts pickReader`): Claude Code's Haiku, or
    Codex's nano / mini, on a team-wide AI account (a dev or office server: the engine's own sign-in). Its turns are the
    owner's with `turns.chat_id = 'chat-summary'`, so Admin › Usage counts them. No tools; the chat is data in
    `<chat>`, and the instructions say it is never an instruction. It keeps the goal, facts (exact names, numbers,
    dates), decisions, every file path read, made or changed, and open tasks. At most 700 words (8,000 characters kept).
  - The summary reads the text the window would show and, per answer, its finished step labels ("Read
    finance/report.xlsx", at most 15): that is where the file paths come from. File contents and tool results are not
    in it, and the block says so (read the file again when its content matters).
  - Cached in `chat_summaries` (migration 418, reader 1) per chat and person, with `covered_count` and the hash chain
    value of exactly those lines. A summary is used only when the history's first `covered_count` lines hash the
    same: a branch (edit, regenerate) reuses the summary of the beginning it shares; a changed beginning never gets a
    wrong one. At most 6 rows per chat and person; they go with the chat (foreign key) and with the account (cleanup
    hook).
  - Kept up to date in steps: when the messages after the summary no longer fit, it is extended (the old summary plus
    the next messages) up to where the rest is half the window. So it is one call per ~80,000 characters of new text,
    not one per message. A first summary of a very long chat is read in chunks of 60,000 tokens.
  - Waiting: a fresh session waits at most 30 s for it, with a step "Summary of the earlier part of this chat" (6
    languages). After that, or when the call fails, or with no team-wide AI account, the answer starts with the window
    alone and its old note ("remembers only the recent part"); the call goes on and the next turn has it. After an
    answer that started fresh (Codex, a shared chat with another writer), the summary for the history with that answer
    is made in the background, so the next message does not wait. A resumed Claude session makes none.
  - `historyTrimmed` (the note under the answer) now means: messages left out that no summary covers, or the newest one
    cut.
- **Rule, shared chats:** the summary is built from the transcript the person whose turn it is gets
  (`labelledTranscript`: who wrote what, an answer hidden from them as one line, attachments as they may see them), and
  step labels only of answers to their own messages (only the asker saw the steps). It is kept per person. When what
  they may see changes (an answer becomes hidden, an attachment goes away), the lines change, the hash does not match,
  and a new summary is made from what they may see now.
- **Rule, the saved session:** a saved Claude session over 8 MB has the pictures of its older turns replaced by a short
  note ("open the file again"), oldest first, down to 4 MB (`chat/session-slim.ts`); the turn from the person's last
  message on keeps its pictures. An image block becomes a text block in the same place, so the session stays valid.
  The stash cap goes from 20 MB to 48 MB, the launcher's own cap for a collected session (native, unchanged). Only a
  session still over that after slimming starts over from the text (now with its summary).
- **Kept:** guests, confidential chats (safe operations) and draft chats get no summary (the window and its note, as
  before). The other-author rule in shared chats (a session is resumed only by the person who wrote it) stays: it is a
  safety rule; the fresh session now gets the summary instead of losing the beginning.
- **Measured** (real AI, local-login, a copy of the QA team, 2026-11-18): a Claude chat with a codename and a budget in
  the first message, then a 171,749-character pasted log, then an edit asking for both. The summary call (Haiku,
  messages 1-3) read 65,902 tokens and wrote 542, $0.0135, 5.2 s; the edited answer took 9.1 s (about 4-5 s
  without the summary) and named both. A regenerate right after reused the cached summary (no call, 4.1 s) and named
  both again. Without a summary the window would have left out the first three messages ("3 earlier messages omitted"):
  the codename and the budget were only in the first.
- **Left out:** a summary on the person's own AI account (the reader uses a team-wide one; without it, no summary);
  token counting with the provider's tokenizer; file contents in the summary.
- **Tests:** `tests/unit/b-history-summary.test.ts` (window, block, cache and hash, chunks, failure, shared-chat step
  lines, Codex and Claude edit / regenerate with the fake engine, no AI, slimming); `b-api` and `b-chat` long-chat
  cases moved to the token window.
- **Version impact:** patch; additive migration 418 (reader 1).
