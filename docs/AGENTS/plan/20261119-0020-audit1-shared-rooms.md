# Word comments in shared chats; room files read up to the read limit

- Date (UTC): 2026-11-18 17:20
- Branch: `fix/audit1-shared-rooms`
- Status: done
- Where: Team AX core (`server/src/rooms/ai-tools.ts`, `server/src/chat/room-tools.ts`). Why: chat tools and their shared-chat allowlist are core.
- Version impact: patch (a tool offered in one more place, a size limit raised)

## Goal

Limits audit 1, items #22 and #23.
- #22: in a shared chat, "add review comments to this Word file" failed: comment_docx was not on the shared-chat
  allowlist, though edit_hwp (which also changes a team file in place) is. Nothing in the decisions left it out on
  purpose.
- #23: a file sent in a team chat room (rooms take up to 1 GB) could be read by the AI only up to 32 MB.

## Scope

In: comment_docx in `SHARED_TOOLS`, its `output` in `WRITE_TARGET_ARGS`; room_file reads up to `readMaxBytes()` and
names the limit when a file is over it.
Out (needs a decision or another PR): schedules and video from a shared chat (#22 rest); people-shared chat uploads
over 50 MB (#25, after #1286 lands); room files over 50 MB saved to the team folder (audit 2 N38).

## Steps

1. Add comment_docx to the shared allowlist, with `output` as its write target.
2. room_file: the read limit, a plain message over it.
3. Tests: b-shared-chat-comment-docx (no card on a project file; read card first on a personal one; fails on old code
   with "unknown tool"); b-chat-rooms (a 40 MB CSV in a room is read).

## Decisions

docs/decisions/20261119-audit1-shared-rooms.md
