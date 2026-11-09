# The in-app AI saves a file sent in a room into the team folder

- Date (UTC): 2026-11-09 06:24
- Branch: `feat/room-file-to-team`
- Status: done
- Where: trina-ax core (`server/src/chat/room-tools.ts`, `server/src/chat/tools.ts`, `server/src/chat/turn.ts`,
  `server/src/chat/prompt.ts`, `shared/src/tools.ts`). Why: chat, permissions and files are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. The person's own AI chat gets a new tool; no API, setting or data change.

## Goal

In the in-app AI chat the owner asked: "save the business registration PDF posted in the leads room so everyone can see
it". The AI said it could not: the PDF exists only as a room attachment, `room_file` reads it as text, `write` writes
text only, so it asked for the PDF to be attached again. A room's own @AI session already has `save_room_file` (a copy of
one of that room's files into the team folder); the person's own chat does not.

## Scope

In:
- `save_room_file` in the person's own chat, with the same name as the room session's tool (as `room_file` has one name
  in both): `room` (as room_read takes it), `file` (its file_id only: two files may share a name, and the card names
  the one file the yes is for) and `save_as` (a folder keeps the file's own name; default the person's downloads).
- One code path for both: the read checks of `room_file` (`findRoomFile` with the person's member row: the room now,
  `visible_from_seq`, threads by their root, hidden answers, others' private previews, not deleted; `RoomFiles.open`
  again before the bytes; the quarantine list, which is the download-only list in code, refused), and the save path of
  the AI's other byte saves (`placeProduced`: write access again, skills/ refused, storage check, a conflict copy next
  to a file not read in this turn, versions, file events), the placement note (`chat/file-placement.ts`) and the audit
  line (`tool_events`).
- A target the person may not write is refused before any card, like skills/ and instruction-file names.
- One card per call (as PR #198 for write and make_file): a tool may say where it saves and what it reads (`Tool.widen`),
  so the wider-audience need, with the room as the source of the bytes, is known before the rooms-seen card (own chat)
  or the room card (room session). When both are needed the wider-audience card alone is asked, with what the call
  saves; its yes is the call's yes. A save into a folder no wider than the room gets the rooms-seen card (the call
  marks the chat first, so even the first call in a new chat asks).
- The card names the file with its room (own chat), its sender, time and size.
- Prompt lines and tool descriptions: the AI knows it can save a room file (ROOMS_RULE, room_file's hints for video,
  audio and scanned PDFs).

Out:
- "이 방에서는 항상 허용" for save_room_file in a room session: PR #198 kept copies, moves and save_room_file out of grants
  on purpose. The room card stays two buttons; only the merging into one card is new there.
- The MCP connector: it has no card, so its read-scope guard would refuse saving room material to any folder wider than
  the room (the owner's case, shared/). Follow-up once a confirmation path exists for the connector.

## Steps

1. `shared/src/tools.ts`: `SaveRoomFileInput` (own chat, with room) and `SaveRoomFileHereInput` (room session).
2. `chat/room-tools.ts`: generalise `saveTarget` / `saveRoomFile` by room; add the own chat's tool with `label`,
   `refuse` and `widen`; the write-access pre-check; the private-preview source.
3. `chat/tools.ts` `Tool.widen`; `chat/turn.ts` `widenNeed` takes read sources; the card's file name for the own chat.
4. Prompt lines and descriptions.
5. Tests: `b-chat-rooms` (member to shared/ with one card and the same bytes, non-member, hidden message, other's
   private preview, existing target, read-only target, quarantined file, no card before a room read into own folder),
   `b-rooms-ai-files` (room session: one card).
6. DECISIONS entry, CHANGELOG line.

## Risks

Permissions: room content copied into team folders. Every read check is the room_file one, every write check the
placeProduced one, and the wider-audience card is computed from the room as the bytes' source. No migration. No new
words on screen (the card and step reuse existing strings in the five languages).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; every test of the touched prefixes: `b-chat-rooms`,
`b-rooms-ai*`, `b-room-ai-grants`, `b-chat-file-placement`, `b-codex-rooms`, chat tools tests.

## Result

Built as planned: `save_room_file` in the person's own chat, one shared path with the room session's, `Tool.widen` for
one card per call (the room session's save went from two cards to one), prompt and descriptions.

Changed after the independent security review: a refusal about the place in a room session counts save_as as a name
read (the answer stays private for a member who cannot see that place; before, the refusal's words reached the room);
the own chat's call marks the chat before it looks anything up (a refusal could show room names to an unmarked chat),
so every save there asks one card; the place the card named is the place written; refusal audit lines never quote the
refusal. The MCP connector stays out (no card there); no grants for room file copies.

PR: not opened (the GitHub account was suspended at the time); branch `feat/room-file-to-team`.
