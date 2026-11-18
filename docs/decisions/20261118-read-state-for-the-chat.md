# The AI's file reads last for the chat, not one answer

- Date: 2026-11-18
- Status: accepted
- Supersedes: the per-turn part of "read before write" (docs/DECISIONS.md, Stage 1: hashes per turn; review M3: per
  agent). The per-agent split inside one answer stays.
- Branch: fix/limits-read-state (limits audit #1, QA TC-4904)

Plan: docs/AGENTS/plan/20261118-1000-read-state-for-the-chat.md.

- **Ask:** "the AI should behave like Claude Code". Claude Code keeps the files it read for the whole session. Here the
  read-before-write hashes started empty in every answer, so "change the date in the report" in message 3, after the AI
  read it in message 1, made it read the file again, or write/edit refused with "read it first", and make_file saved
  "report (2).docx" next to the original.
- **Shape:** each finished turn keeps what its AI read or saved (TurnFiles.allReads: path -> sha256 of the version it last
  saw, sub-agents included) in `chat_reads`, under its answer, its person and its engine session (migration 419_b; rows go with the chat, the
  answer and a deleted account: chat/account-cleanup.ts). The next turn of the
  same person gets the rows of the answers above its message on that branch, the newest per path
  (chat/carried-reads.ts). The main AI and its sub-agents fall back to them for a path they did not read in this answer
  (files/service.ts ReadHashes). An answer's own reads stay per agent, as before.
- **Safe on use:** a carried read counts only while (1) the file is still exactly that version (sha256 of the file now)
  and (2) the person may read it now (authorize with the current folder rules and a fresh principal); the write itself
  checks write access as always. A changed file is refused with `stale_read` "read it again" (nothing saved, no
  conflict copy, no overwrite from an old read). A file the person can no longer open counts as never read.
- **Whole-file replaces only in the same session:** `write` and `make_file` may rely on an earlier answer's read only
  when this turn resumed the very engine session that made it (it still holds the file's text). A fresh session
  (Codex, the API engine, a lost or oversized stash, an engine switch, another person's turn in between, a summarized
  history) gets `edit` and the in-place tools only (edit_hwp, comment_docx, the PDF and image tools work from the exact
  old bytes): `write` asks for a read, `make_file` asks for a new read before any conversion instead of a copy.
  The session is recorded per path when the text is seen: a sub-agent's read (the main session never saw it) and a read
  made before the turn moved to another session (an account switch, a "No conversation found" retry) are saved without
  one. A sub-agent never replaces a whole file from an earlier answer's read (it never saw that text); it may edit.
  A compaction in the middle of an answer (the stream's system line, parsed into a `compacted` event,
  engine/claude-parse.ts) turns whole-file replaces from what was read before it off at once, for the rest of that
  answer. A compaction in the stash (Claude Code's `compact_boundary` or `microcompact_boundary` system line, both checked in
  the shipped binary) clears the chat's sessions on its reads: edits
  only from then on. A stash slimmed by #1283 (pictures of older turns taken out) does the same
  (`sessionDroppedText` in chat/turn.ts stashSession). A fresh session that starts from #1283's summary has a new
  session id, so earlier answers' reads never allow a whole-file replace there.
- **Only recent answers for a whole-file replace:** Claude Code 2.1.327 also has a time-based "keep recent"
  micro-compaction (`tengu_time_based_microcompact`, "[KEEP-RECENT MC]") that clears old tool results; the binary
  shows no boundary line written for it, and it was not reproduced in a real session. So an earlier answer's read
  allows `write` / `make_file` only when it is from the last 2 answers on the branch (`WHOLE_FILE_RECENT_ANSWERS`);
  older reads allow edits and the in-place tools only. A replace always keeps the old version in its history.
- **Per person:** rows carry the turn's person and only that person's rows load. In a shared chat person B's turn never
  uses person A's reads, because their access differs. An edited or regenerated message starts a branch without the
  other branch's reads.
- **Not carried:** guests and restricted runs (neither saved nor loaded; their reads stay per answer); a tool call whose agent is not known while
  sub-agents run (fails closed, as before); saves of a new thing (save_url, save_room_file, save_promo_video,
  generate_video, unzip_file: `thisAnswerOnly`), which keep a copy next to a file the chat saw earlier, as before.
- **make_file:** an output the person's AI read (or made) earlier in the chat and that is unchanged is replaced, with
  its old version in its history; changed since: asked to read again; never read: a conflict copy as before (asking
  for a new file still makes a new file). The tools that change a named file (edit_hwp, comment_docx, stamp_pdf,
  edit_pdf, resize_images with replace) follow the same reads.
- **Bounds:** the newest 2,000 paths per answer and the newest 20,000 rows per chat; the load reads only the branch's
  answers; a file's current hash is remembered while its lstat (ns times, inode, size) is unchanged. Paths and hashes
  only, never content.
