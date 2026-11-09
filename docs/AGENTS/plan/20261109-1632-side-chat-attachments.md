# Files and pictures in the Trina side chat: 📎, paste, drop

- Date (UTC): 2026-11-09 16:32
- Branch: `feat/side-chat-attachments`
- Status: in progress
- Where: trina-ax core (`web/src/components/rooms/SideChatPanel.tsx`, the AI chat box's attachment part). Why: chat
  and files are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new ability in the side chat's box; no API, setting or data change.

## Goal

The Trina side chat beside a room (✦, the person's own private chat, `chats.side_room_id`) sends text only: its box
sends `attachments: []`. A person who wants to ask about a screenshot or a PDF has to open the full chat. The side
chat's box gets what the AI chat's box has: attach, paste, drop, the 64 px picture tiles above the box, the same limit
and the same errors. The answer sees the files exactly as in a full chat.

## Scope

In:
- 📎 in the side chat's box: files from this computer (phones: from the device).
- Paste a picture or a file into the box; drop files anywhere on the panel (the box shows the drop like the AI chat's).
- The chips above the box: the AI chat box's own, a picture as its 64 px tile while it uploads, a file as its chip,
  each with ✕ and its upload error; at most 20 per message (`composer.tooMany`).
- Uploads go into the side chat itself (`POST /api/uploads` / an upload session with `kind: attachment`, stored in the
  person's own `users/<me>/.attachments/<chatId>/`, as for any chat of theirs). A side chat that does not exist yet is
  made by the first file, as the first question makes it today.
- Sending: the ready files go with the message through `useChats.send` (`attachmentIds`); a message may be files alone.
  An answer to the AI's question stays text only (files stay in the box), as in the AI chat's box. The starter and
  quick-question buttons send their question alone and leave the box's files, as they leave its text.
- The same chips in every panel of the room (the room page's and the file viewer's column): kept per room on this page,
  like the side chat's draft. "New chat" and opening another side chat from 🕘 drop them (they were uploaded into the
  chat that was open).
- The message list already shows a message's attachments (`UserMessage`): nothing new there.
- "Share to room" stays as it is: it sends the answer, never the question's uploads (checked, see Risks).

Out:
- Files of the team folder (the AI chat's "팀 폴더에서" menu, a team file dragged from the file screen): the side chat
  reads the room; a team file can still go through the full chat. A follow-up if asked for.
- No camera item: a phone's file picker offers the camera itself.
- No new endpoint, no server change.

## Steps

1. Take the attachment part out of `components/chat/Composer.tsx` into one shared place, with no visible change to the
   AI chat's box: the chips' state (kept per draft, `lib/teamAttach.ts`), uploads, the limit, removing, the chip row
   (`PictureTile` and the file chip) and the drop target. `lib/teamAttach.ts`: several boxes may show one draft (both
   side chat panels of a room), so each hears the others' changes.
2. `SideChatPanel`: 📎, paste, drop on the panel, the chip row above its box, the files in the send body, the chat made
   for a first file, the chips dropped on "New chat" / another chat.
3. Unit tests (`web/test/unit/side-chat.test.tsx`): attach, paste, remove, the send body with the attachments, a failed
   upload. e2e: a pasted picture in the side chat (tile, send, the message shows it), a PDF through 📎; the side chat,
   room and composer specs; the full web e2e once (the AI chat's box changed).
4. DECISIONS, CHANGELOG, screenshots (1440 light pasted, 1440 dark sent, 390 light).

## Risks

- Privacy: the uploads are the person's own (their chat, their folder), as in any chat of theirs; the side chat is never
  shared (`createChat` refuses a project with `sideRoomId`). Nothing about a room's members changes.
- "Share to room" (`server/src/chat/answer-share.ts`): it posts the answer's text; files go only when the answer links
  them, asked first on the confirm step with how many more people will see each; an answer that used an attachment
  counts as material the others cannot see (the provenance line). The question's uploads never ride along.
- The AI chat's box is changed by the extraction: the composer specs and the full web e2e must stay green.
- Five languages: only the 📎 button's name, which exists already (`composer.attach`).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the e2e specs
above and the full web e2e once.

## Result

Filled in at the end.
