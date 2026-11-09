# Room files open on click; a shared answer's links open the attached copy

- Date (UTC): 2026-11-07 16:16
- Branch: `feat/room-files-open`
- Status: done
- Where: Team AX core (`server/src/rooms`, `server/src/chat/answer-share.ts`, `shared/src/api/rooms.ts`,
  `web/src/components`). Why: rooms, files and permissions are core (see docs/REPOSITORY-RULES.md).
- Version impact: minor. Room file chips open a preview (a visible UI change) and `RoomMessage` gains one optional
  field; no database change.

## Goal

The owner: "다운받는 것도 있으면 좋긴 한데, 그냥 열어주면 안되는거야? 그리고 필요하면 다운받고? 링크도 그냥 유지하면
안되니? 지금은 링크가 you don't have access라 떠서.. 어차피 첨부한거라면 말이지?"

1. A file chip in a room opens the file in the app's preview panel (a full-screen sheet on phones), like a file link in
   the AI chat. Download stays, as a small icon on the chip and in the panel.
2. In an answer shared with "첨부해서 보내기", a link to a team file that went with the message opens the team file for
   whoever may open it now, and the attached copy for everyone else, with no lock. The lock stays only when there is
   neither.

## Scope

In:

- `PreviewFile` gets `{ source: 'room', roomId, fileId, name }`. `FilePanel` loads it through
  `GET /api/rooms/:id/files/:fileId` (the room's member check on every read), bounded by `previewLimit`, and draws it
  with the same viewers: HTML / SVG only in `SandboxFrame` (`/sandbox/frame`, opaque origin, its CSP) or `StaticFrame`,
  never srcdoc or a blob: page of the app; no team images are pulled into a room page (no folder). HEIC and HWP, which
  need the server's team-file converters, and anything without a viewer show the existing "can't preview" notice with a
  download button. The panel's download is the room file's `?download=1`.
- The chip: one button opens the panel; a small download icon next to it. A file the panel cannot show (no viewer, or
  larger than its limit) stays one download button, as today. Photos keep their thumbnails, which open the same panel.
- A quarantined room file (safe operations' download-only list) is served only as a download (`?download=1`, not
  fetched by a page): no inline read and no thumbnail, as for team files.
- `shareAnswerToRoom` keeps, per attached file, its team path and the answer's links that point at it, in the
  message's existing `source_scope` JSON (`attached: [{ file, path, links }]`). No migration.
- `RoomMessage.attachedLinks` (optional): for a shared answer the viewer sees, the links of its answer part (as
  `answerFilePaths` names them, text the body already has) whose file is one of this message's files, with that file's
  id. Never the stored team path, never for a message hidden from the viewer, a deleted one, or a link the body does not
  have. Older messages have none and keep the lock.
- `Markdown` resolves a team-file link: openable now → the team file; else an attached copy → the room file; else the
  lock. Pictures the same way.

Out: an "이미 보냄" marker, previews of room HEIC / HWP files, attaching from other places than a shared answer.

## Steps

1. Plan (this file).
2. Server: `attached` in the shared answer's scope; `attachedLinks` in `messagesOut`; the quarantine rule on the room
   file route. Unit tests.
3. Shared: `RoomMessage.attachedLinks`; API docs.
4. Web: the room source in `FilePanel`, the chip, the link resolution in `Markdown`; web unit tests; i18n in five
   languages.
5. e2e at 1440 and 390 with axe; ui-polish screenshots in light and dark.
6. DECISIONS (대화방에 보내기), CHANGELOG.

## Risks

- Security: room HTML must never run with the app's origin. It is fetched as bytes (`text/plain` with a sandbox CSP
  inline, an attachment with `?download=1`) and drawn only in the sandbox frame. A file of another room or of a message
  the viewer cannot see answers 404 as today.
- The link mapping must not tell a viewer a team path: it is keyed by the link text of the body they already get, and
  only lists files of that message.
- No migration (the JSON column exists since migration 264). Phone and desktop: the panel is the existing sheet.
- Five app languages for the new words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` and the docs-site test; unit tests
for rooms, room files, answer sharing and the files routes, and the security suite; `bun run test:web`; the full web
e2e.

## Result

Built as planned, no migration (the mapping lives in `room_messages.source_scope`, migration 264's JSON column).

- Server: `shareAnswerToRoom` keeps `attached: [{ file, path, links }]`; `messagesOut` sends
  `RoomMessage.attachedLinks` per viewer (only seen messages, only links the answer text has, only files of that
  message, never the stored path). A download-only room file goes only with `download=1` and never into a page element.
- Web: `PreviewFile` source `room`; `FilePanel` reads room files through the room and draws them with the same viewers
  (HTML only in the sandbox frame); the chip opens, a small icon downloads, a file without a viewer stays a download;
  `teamLinkTarget` resolves a link to the team file, the copy or the lock.
- Differs from the plan, from the independent security review: inline XML document types (`+xml`, MathML, WML) and
  script types under other names (ECMAScript, JScript) are sent as text like HTML and JavaScript (team files too); a
  room or local Markdown preview shows team pictures as links and loads no upload thumbnail; a fetched `download=1` of a
  held room file is allowed (the phone app downloads through fetch) while picture, frame, player, object and script
  destinations are refused.
- PR: https://github.com/trina-app/trina-ax/pull/179
