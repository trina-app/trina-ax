# The AI's file reads last for the chat, not one answer

- Date (UTC): 2026-11-18 10:00
- Branch: `fix/limits-read-state`
- Status: in progress
- Where: server/src/files/service.ts (TurnFiles read hashes), server/src/chat/ (a new carried-reads.ts, two calls in
  turn.ts), server/src/tools/make-file.ts, server/migrations. Why: the read-before-write state and make_file's save
  path live there (see docs/REPOSITORY-RULES.md).
- Version impact: minor, one additive migration (reader 1)

## Goal

Limits audit #1 (QA TC-4904). The read-before-write hashes start empty in every answer and per agent, so in message 3
"change the report you read in message 1" makes the AI read it again, or write/edit refuse with "read it first", and
make_file saves "report (2).docx" next to the original. Claude Code keeps read state for the whole session.

## Scope

In: carry the reads of the person's own earlier answers on this branch of the chat into the next answer (main AI and
its sub-agents); on use, check the file is still the version read and that the person may still read it; a changed file
asks the AI to read it again (no conflict copy, no overwrite); make_file replaces a file read earlier in the chat.
Out: guests and restricted runs (keep reads per answer), the remote MCP connector's own state, anything about what the
model remembers of the file's text.

## Steps

1. Migration 418_b_chat_reads.sql: chat_reads(chat_id, message_id, user_id, path, sha256), cascades with the chat and
   the answer.
2. chat/carried-reads.ts: save a turn's reads (allReads) under its answer at finish; load the person's own rows of the
   answers above the new message on its branch, newest first wins.
3. TurnFiles.carried + ReadHashes.get/has fall back to it: the file's sha256 now (read permission checked now, fresh
   principal) must equal the carried one; changed -> ToolError 'stale_read' "read it again". An unknown-agent call
   view gets none (fails closed).
4. Tool wording: "read it in this turn" -> "in this chat" where the read state is meant (not "made in this turn").
5. Unit tests: carried read lets edit/write/make_file update in place; changed file refused with re-read; person B in
   a shared chat does not get A's reads; another branch does not carry; lost read permission does not carry.

## Decisions

docs/decisions/20261118-read-state-for-the-chat.md
