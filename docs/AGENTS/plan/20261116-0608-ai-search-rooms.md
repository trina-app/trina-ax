# A team file search also says when the person's rooms mention the same words

- Date (UTC): 2026-11-16 06:08
- Branch: `fix/ai-search-rooms` (QA TC-3709)
- Status: done
- Where: trina-ax core (`server/src/chat/room-hint.ts` new, `server/src/chat/tools.ts` afterFileTool). Why: the AI's tools are core.
- Version impact: patch. One line added to a grep result; no prompt text.

## Goal

AI scenario FLOW-03 (and the 2026-11-16 re-runs of #1073): asked for a client visit prep sheet, the AI searched only the
team files and said nothing answered "Saturday delivery", which a teammate had answered in the client's group chat.

Evidence (the Claude Code request the dev server sent, `api-request-shape` in the session record): all 39 tools are in
the request in full, `mcp__team__rooms` and `room_read` with their descriptions; ToolSearch is denied
(engine/claude.ts CLAUDE_BUILTIN_DENIED), so nothing is deferred. A sentence in ROOMS_RULE (2 runs) and one in the rooms
description (2 runs) did not change it: the AI never thinks of rooms while it searches files.

## Scope

In: when the AI greps the team files in a turn that has the rooms tool (the person's own chat; never a shared chat,
a guest or a scheduled template run, where it is not offered), the plain words of the pattern are searched in the
rooms the person is in (rooms/search.ts searchRoomMessages: only messages they see). If any match, the grep result gets
one line: how many messages in how many rooms, and to search them with rooms. No room name or text in the line. Once
per word per turn.

Out: glob, read; a pattern with regular-expression syntax beyond "a|b" (no hint).

## Steps

1. This plan. 2. room-hint.ts and the afterFileTool hook. 3. Unit tests. 4. Changes fragment, checks, scenario re-run
(FLOW-03 twice, ROOM-02, ROOM-05, FLOW-05), PR.

## Result

Built as planned. FLOW-03 passed twice (it grepped "라마바|Lamaba", got the line, searched the rooms, read the thread and
wrote "Saturday is courier-only"); ROOM-02, ROOM-02.not-member, ROOM-05 (3 variants) and FLOW-05 still pass.
