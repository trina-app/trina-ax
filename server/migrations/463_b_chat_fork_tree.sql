-- min_compatible_reader: 1
-- Component B: forks as a tree in the Trina history (docs/decisions/20261126-chat-fork-tree.md, server/src/chat/fork.ts).
-- chats.fork_parent: the chat this fork sits under in its person's list (NULL: a top-level row). Apart from fork_of
-- (where the copied words came from, the "Continued from" line): "Detach to top level" clears fork_parent only, and a
-- chat purged from the trash hands its forks to its own parent (chat/runtime.ts purgeChat) while fork_of stays.
-- Forks made before this sit under the chat they came from.
-- 463: 461 (#586) is the highest b on dev; 462 is the chat fork (#641) in the same batch; 460 was this PR's
-- earlier number, never on dev.
-- Additive only (reader 1): an older build ignores the column (its forks show as plain rows).
ALTER TABLE chats ADD COLUMN fork_parent TEXT;
UPDATE chats SET fork_parent = fork_of WHERE fork_of IS NOT NULL;
CREATE INDEX chats_fork_parent ON chats(fork_parent) WHERE fork_parent IS NOT NULL;
