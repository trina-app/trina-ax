# Posting a private room AI answer asks first, with how many people will newly see it

- Date (UTC): 2026-11-12 02:49
- Branch: `fix/room-ai-share-confirm`
- Status: in progress
- Where: trina-ax core (`server/src/rooms/ai.ts`, `shared/src/api/rooms.ts`, `web/src/components/rooms/`,
  `web/src/components/chat/ShareToRoom.tsx`, `web/src/i18n/`). Why: team chat rooms and their AI are core features
  (docs/REPOSITORY-RULES.md)
- Version impact: patch — a fix of an existing step; the share endpoint takes an optional body and answers sent/confirm

## Goal

QA TC-329: in the older "@Trina in the room" mode (`roomAiMentions`), an answer built from the asker's private files
stays a private preview, but one `POST /api/rooms/:id/messages/:messageId/share` posts it with no confirm step: the
server never asks. The side chat's "send to room" answers "confirm" first (how many people would newly see it, the
places they cannot see, a `confirmKey`) and posts only with that key. The room AI share should do the same.

## Scope

In:
- `RoomAi.share` answers `{ status: 'confirm', … }` (the side chat's confirm shape: people, places, files, provenance,
  confirmKey) when the preview used material some member who will see it cannot see (decide(): folders, the asker's
  own folder, messages from before someone joined, earlier hidden answers' sources) or a source file some of them cannot
  open; it posts only when the same call comes again with that key. The key is the side chat's keyed hash
  (`confirmMac`), over the person, room, message, who misses what, and the reasons: another message, a change in
  members or access, or a server restart asks again.
- Nothing private (only the web, or nothing at stake now): posts at once, as before.
- Web: the "Post to room…" action shows the side chat's confirm card (`ShareConfirm`, the same words) when the server
  asks; previews with nothing private keep today's dialog.
- Audit `room.ai_share` gets `confirmed` and `people`.

Out: the default side chat path (unchanged); the reasons the preview line shows (unchanged).

## Steps

1. decide(): also return the member ids (never stored, never sent) who miss something.
2. share(): confirm step with `confirmMac`; response type `ShareRoomMessageResult`, optional body `{ confirmKey }`.
3. Web store + PreviewLine: confirm card via `ShareConfirm`; i18n for the source rows' header and caption.
4. Tests: server (private → confirm then posts with key; non-private → posts at once; key of another message refused),
   web unit test for the card.

## Risks

No migration. The response of the share endpoint changes shape (only the web app calls it; it is served by the same
server). Five app languages for the two new strings.
