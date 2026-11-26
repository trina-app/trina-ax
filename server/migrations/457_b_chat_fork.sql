-- min_compatible_reader: 1
-- Component B: a chat forked from a shared chat (docs/decisions/20261126-chat-fork.md, server/src/chat/fork.ts). The
-- shared chat's "Continue in a chat only you see" copies the conversation as the person sees it into a new chat of
-- theirs. fork_of / fork_at: the shared chat and its message the copy ends at (the line "Continued from ‹title›" links
-- there while the person may still open it); fork_title: that chat's title at the copy (shown when it can no longer be
-- opened); fork_pending: the copy's first answer has not run yet (it resumes the person's own engine session of the
-- shared chat once, with checks for that person only: chat/turn.ts). messages.fork_copy: a row copied by the fork (its
-- words do not follow later edits in the original); messages.withheld_copy: an answer hidden from the person in the
-- original, copied as one line without content, steps or files (chat/shared-answers.ts keeps it hidden).
-- 457: 456 (model effort, #631) and 455 (auto mode) are on open PRs; 454 is the highest b on dev.
-- Additive only (reader 1): an older build ignores the columns (a fork reads as a private chat others wrote in).
ALTER TABLE chats ADD COLUMN fork_of TEXT;
ALTER TABLE chats ADD COLUMN fork_at TEXT;
ALTER TABLE chats ADD COLUMN fork_title TEXT;
ALTER TABLE chats ADD COLUMN fork_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN fork_copy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN withheld_copy INTEGER NOT NULL DEFAULT 0;
