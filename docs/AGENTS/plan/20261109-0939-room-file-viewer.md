# Files from team conversations open in a Slack-style viewer; the side panel gets "크게 보기"

- Date (UTC): 2026-11-09 09:39
- Branch: `plan/room-file-viewer` (the work: one `feat/room-file-viewer-*` branch per PR below)
- Status: in progress (a #249, b0 #259, f #254 on dev; b #261; c0, c, d, e to come; #247 is on dev now)
- Where: trina-ax core (`web/src/`; if question 2 is a yes, one optional field on the chat send body in `shared/` and
  `server/src/chat/`). Why: rooms, chat and file previews are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible UX change; no migration, no new endpoint.
- Builds on: `feat/image-viewer` (plan `20261109-0817-image-viewer.md`, not on dev yet) and PR #236 (Trina side chat,
  merged into dev on 2026-11-09; its PR 2 is to come). Neither is duplicated.

## Goal

A file opened from a room, DM, group chat or thread opens like Slack's file viewer: a large overlay with who sent it,
when and where; the document large in the middle; page thumbnails on the left for a PDF; → / ← to the pane's other
files; on the right the message's thread or the person's Trina side chat. Today it opens small in the side panel with a
download only. The AI chat and Files keep the side panel (it sits beside the AI and has the AI actions) and get a
"크게 보기 ⤢" toggle.

## Inventory

What the side panel draws (`FilePanel.tsx` `Viewer`, kinds from `lib/preview.ts`):

| Kind | Component | A room file today | Paged | In the viewer |
|---|---|---|---|---|
| PDF | `viewers/PdfView` (react-pdf 11, pdfjs 6.3): all pages drawn at once, its own zoom bar, `startPage` | panel | yes | as is, plus lazy pages and thumbnails (PR d) |
| png, jpg, gif, webp | `MediaView` `<img>`; the image viewer once feat/image-viewer lands | image viewer | – | the image viewer's stage is the picture mode |
| HEIC, HEIF | server JPEG (`/api/files/preview`, team files only) | thumbnail → image viewer; chip downloads | – | picture mode on the thumbnail, with download |
| DOCX | `DocxView` (docx-preview 0.4.1) | panel | no (breaks only at explicit page breaks) | as is, no thumbnails |
| PPTX | `PptxView` (@aiden0z/pptx-renderer 1.4, windowed slide list) | panel | slides | as is; slide thumbnails not in this plan |
| XLSX, XLS, ODS | `SheetView` (SheetJS, first 5,000 rows, sheet tabs) | panel | tabs | as is |
| CSV, TSV | `TextKinds` table (2,000 rows) | panel | – | as is |
| Markdown | `TextKinds` → `Markdown` (front matter; team pictures as links for a room file) | panel | – | as is, in a reading column |
| Text, code, JSON, YAML, XML | `TextKinds` → `<pre>` / `CodeBlock` (first 2 MB) | panel | – | as is |
| HTML, SVG | `SandboxFrame` / `StaticFrame` + `useFrameFiles` (room file inline as text with a sandbox CSP) | panel | – | as is |
| Video, audio | `MediaView` `<video>` / `<audio>` | panel | – | as is |
| HWP, HWPX | `viewers/HwpView`: a server PNG per page (`API.hwpPreview` by team path, HWP plugin) | chip downloads (`opensWithoutServer` false) | yes | file card: no room address for it (question 5) |
| Other (zip, doc, ppt, …), over the limit | "preview-unsupported" notice + download | chip downloads | – | file card |

Limits (`previewLimit`): text kinds show their first 2 MB, pictures 20 MB, audio and video 60 MB, the rest 50 MB (the
room upload maximum).

Reuse without copying: the viewers in `components/viewers/` are standalone already. FilePanel's loader effect (the blob
by source, with the limits and the quarantined / busy / too large / missing errors) and its body switch (`Viewer`,
`MediaView`, `TextKinds`, all module-private) move to `components/FileBody.tsx` (`useFileBlob(file, rev)` and
`<FileBody>`); FilePanel keeps its header, editing and actions and renders `<FileBody>` (PR b0).

What the panel offers:

| Action | Team file | Room file | Local file |
|---|---|---|---|
| Ask AI (`chatActionsFor`: team, not missing, not download-only) | yes | no | no |
| Add to chat (a chat is the target) | yes | no | no |
| Open in Files | yes | no (not in a folder) | no |
| Edit (md, text, code, csv, html, svg, xml; write access, `baseSha256`) | yes | no | no |
| PDF로 저장 (.html, `Me.server.htmlPdf`) | yes | no | no |
| Download | yes, unless missing | yes (`?download=1`) | yes (`saveBlob`) |

A room file has the download only. The viewer adds the thread, Trina and a link; its AI actions go through the Trina
side chat, not the panel's team-file actions.

## Computers

**Entry.** In a room, DM, group chat or thread: a file chip's name (today the side panel), a picture (the image viewer
after feat/image-viewer), and a shared answer's link to its attached copy (`attachedCopies`: a file of that message).
Unchanged: team-file links in room messages and answers (side panel), the room box's unsent pictures, and every picture
outside rooms (the image viewer as it lands).

**One overlay, the image viewer's.** `lib/imageViewer.ts` `ViewerItem` gains `kind: 'image' | 'file'` and
`room: { roomId, fileId, messageId, rootId, threadable }`; `FileChip` registers through `useViewerItem` as `RoomPicture`
does. The pane's list (DOM order, only what is drawn, never across panes) then holds pictures and files together. A
picture keeps the image viewer's stage (zoom, pan, gestures); a file uses the document stage. The host, the portal, the
focus trap, the history entry (Back closes it), the close on a route change and the focus return are the image
viewer's.

- **Bar** (one, at the top, for room pictures too): the sender's `Avatar` and name (`AiFace` for an AI answer), the
  time (`formatRelative`: "3일 전", a date after 7 days; the full time in the tooltip), the room's title, the file's
  name and size; on the right zoom (picture, PDF), download, the right-column toggle, ⋯, ✕. No second bar at the
  bottom: one row is leaner and keeps one layout for both modes.
- **⋯**: 링크 복사 (the message link the app reads already, `/rooms/<id>?m=<message>` or `/rooms/<id>/t/<root>?m=<reply>`;
  it opens for members only), 트리나에게 묻기 (the Trina tab, this file as its context), 팀 폴더에 저장 (question 3),
  새 탭에서 열기 (as in the image viewer: plain browsers only, for kinds a browser shows itself).
- **Thumbnails** (PDF only, PR d): page renders from the one loaded pdf.js document (no second parse), 96 px wide, no
  text or annotation layer, drawn only in view (IntersectionObserver) in a virtualised list (row height from page 1's
  shape, corrected as each page's size is known). The current page is marked and follows the scroll; a click scrolls
  there. Hidden below a 1,100 px window and by a toggle. None for DOCX (not paged), PPTX (every slide drawn twice),
  sheets (tabs) or HWP (no room preview).
- **Centre**: `<FileBody>` on the dark stage, the page column fitted to the stage up to 960 px. PDF zoom moves to the
  bar's − % + (PdfView's steps; its own sticky bar is off in the overlay). ↑ ↓ PageUp PageDown Space scroll.
- **← →**: the edge arrows and the keys step through the pane's files with "3 / 8". Keys from the right column, a text
  field, a sheet or a frame are left alone. Documents are not preloaded; a step releases the last blob.
- **Keyboard, focus**: Esc closes unless a menu, the mention list or a card took it; a draft in the thread box stays
  (`roomDrafts`). Focus starts on the stage, Tab reaches the bar and the column, and goes back to the chip or picture on
  close. `aria-label` "파일 보기: {name}".

## The right column: 스레드 · 트리나 (checked against PR #236)

PR #236 has `SideChatPanel`: a private ordinary chat of the person (`chats.side_room_id`, migration 276) whose AI
reads the room with `room_read` / `room_file` as they see it, and Share to room through `ShareToRoom`. In `pages/Room.tsx`
it is a sibling of `ThreadPanel`, one of the two at a time: `sideOpen` is local state of `RoomView`, a thread in the URL
closes it.

What this plan adds, nothing else:

1. **One column component**, `components/rooms/RoomSideColumn.tsx`: the section, the header and the divider around the
   two bodies (`ThreadPanel`, `SideChatPanel`) with a 스레드 · 트리나 switch in the header. The room page and the viewer
   both use it; the room page looks as it does now (question 1).
2. **What is open on the right moves into the rooms store** (`side[roomId]: 'trina' | null`, beside the URL's thread),
   so the viewer, a portal outside `RoomView`, can read it.
3. **Default**: Trina open → the Trina tab. A thread or nothing open → the file's thread: the message's root (a reply's
   `threadRootId`, the reply highlighted). A message without replies shows alone with an empty reply box ("스레드에서
   답장"); `ThreadPanel` already does that for a root without replies, and the first reply starts the thread. A message
   that cannot be a root (`threadable` false: an AI private preview) shows alone, without a box. A step to another
   message's file moves the thread tab with it; the Trina tab stays.
4. **Trina's context** is the file on screen, said in one line above its box ("보는 중: {name}"). How the AI learns it:
   question 2.
5. **Small props on the two panels, no copies**: `frame={false}` on both (the column draws the frame);
   `SideChatPanel` gets `autoFocus` (it focuses its box on mount, which would take focus from the stage) and `viewing`;
   its draft and chat id move to a per-room module map (like `roomDrafts`), so the page's and the viewer's show the
   same chat and draft.

Conflicts with #236 (now on dev), settled in PR c0:

- `Room.tsx`: `sideOpen`, `setSideOpen` and the effect that closes it when a thread opens move to the store; the two
  siblings become one `<RoomSideColumn>`.
- Both panels size themselves (`md:w-[var(--panel-w,…)]`, a `PanelDivider` on `THREAD_PANEL` that measures the previous
  sibling). In the viewer that sibling is the stage: the column gets its own `VIEWER_COLUMN` sizing (400 px, its own
  remembered width).
- `useRooms.threadView` is one slot and `closeThread` empties it: a thread on the page and one in the viewer (even the
  same one) would wipe each other on close. c0 keys it by root with a count of who has it open (`threadViews`), and the
  live events update each.

After PR 2 removes @트리나: the viewer uses no room AI session or endpoint (no `getRoomAi`, no "@트리나" in the box).
`ThreadPanel` shows `RoomAiStatus` until PR 2 removes it; the viewer follows by reuse. Old AI answers keep their files
(sender `AiFace`); an old private preview shows alone. 트리나에게 묻기 and 팀 폴더에 저장 use the side chat only.

## Phones (< 768 px and the phone app's WebView)

Full screen with the bar on top (a tap shows or hides it in picture mode, as the image viewer does). The column starts
closed; a "스레드 N" / ✦ button in the bar opens it as a full-height sheet with the same switch. Back closes the sheet
first (its own history entry, the image viewer's helper), then the viewer. Picture mode keeps the image viewer's
gestures (pinch, double tap, sideways swipe steps, swipe down closes). Document mode scrolls and pinches natively; it
steps by the bar's ‹ › only and has no swipe-down close (both would fight the scroll). No thumbnails.

## Access (existing endpoints and checks only)

- Bytes: `GET /api/rooms/:id/files/:fileId` (inline, `?thumb=1`, `?download=1`): current members, the message visible to
  them and not deleted, on every read (`RoomFiles.open`). Thread: `GET …/messages/:id/thread`; replies:
  `POST …/messages` with `threadRootId` (`threadable`, `canSee`). Trina: #236's `createChat` / `listChats` with
  `sideRoomId`, and `sendMessage`.
- Download-only (quarantined): the inline read answers 503 `quarantined`; the stage shows the file card with download
  and the notice; 트리나에게 묻기 and 팀 폴더에 저장 are left out (the AI is refused those bytes).
- Too large, unknown kind, HEIC or HWP in a room: the file card (icon, name, size, kind) with download; the column works.
- Hidden messages: a withheld answer draws no file, another person's private preview never reaches me: never listed.
- Deleted while open: the live event marks it in the store; the stage says the message was deleted, the blob is dropped,
  download goes, stepping still works. Taken out of the room, or the room gone: the viewer closes.
- No cache beyond the open file's blob in memory; no new address.

## Performance

- PDF: `PdfView` draws every page today. PR d draws only pages within a screen of the viewport (placeholders sized from
  each page's viewport), unmounts far ones, and caps the canvas (device pixel ratio ≤ 2, width × ratio ≤ 4,096 px; zoom
  beyond that scales with CSS). The side panel gets the fix too. Thumbnails mount canvases only for rows in view.
- Memory: one file at a time (its blob and one pdf.js document for stage and thumbnails), freed on a step or close.
  Later, if needed: pdf.js range loading from the same inline address (the server serves Range) for PDFs over 10 MB.
- Kinds the browser cannot draw: HWP goes through the server preview for team files only (`API.hwpPreview` by path), so
  a room HWP gets the card (question 5); HEIC shows the server-made thumbnail.

## "크게 보기" in the side panel

- A ⤢ button in the FilePanel and ArtifactPanel headers, left of ✕, on computers only (phones: full screen already).
  "크게 보기"; while big "원래 크기로" (⤡). Not on the Browser pane.
- Big: the panel takes the main area right of the sidebar (`<main>` hidden, the panel `flex-1`, the divider hidden). The
  remembered width is untouched and comes back. Beside a room's thread (`besideThread`) it covers room and thread alike.
- Esc: the first returns to normal size, the next closes the panel (Layout's handler; Files clears a selection first in
  the same way). The toggle returns too.
- Kept while the panel is open (a file opened from a link in it stays big); it ends when the panel closes; not stored.

## PRs, in order

Each runs typecheck, check:i18n, check:docs, the touched unit tests, test:web, build:web, the named e2e specs, and gets
a review. b and c also run the full web e2e (shared room components).

- a. **크게 보기** (no dependency): `lib/sidePanel.ts` `expanded`, Layout, SidePanelFrame, the two headers, five
  languages. Unit: ends on close and on a route that closes the panel; Esc order. e2e `side-panel-expand.spec.ts`: chat
  → file → big → Esc → normal → Esc → closed; the Files page; no button at 390 px.
- b0. **`FileBody` / `useFileBlob` out of FilePanel**, no visible change; the panel specs (`file-preview*`,
  `room-files-open`, HWP, sheet) pass unchanged.
- b. **Viewer, document mode** (after feat/image-viewer): item kinds, chips register, the bar, the file card, ⋯ (link,
  new tab), quarantined / unknown / deleted. No column yet. Unit: mixed list order, card per case. e2e
  `room-file-viewer.spec.ts`: a PDF chip opens it, ← → to a picture and back ("1 / 2"), Esc returns focus, Back closes,
  quarantined card, deleted while open. `room-files-open.spec.ts` updated.
- c0. **Right-column refactor** (#236 is on dev): store `side`, keyed `threadViews`, `RoomSideColumn`, the `frame` and
  `autoFocus` props. No visible change. Unit: `rooms-store`, `room-thread`, `side-chat`; the thread and side-chat e2e.
- c. **Column in the viewer**: default, switch, toggle, the file's thread and box, the Trina tab with "보는 중",
  트리나에게 묻기, 팀 폴더에 저장. With question 2: `SendMessageBody.viewing`, its server check and prompt line,
  `docs:api`; `b-side-chat` unit (member yes; not a member, another room, deleted, withheld, quarantined, not a side
  chat: ignored). e2e: a reply from the viewer is in the room's thread; Trina stays across steps.
- d. **Lazy PDF pages and thumbnails**. Unit: the window math. e2e with a 60-page fixture: few canvases mounted, a
  thumbnail click scrolls, the current page follows.
- e. **Phones**: the sheet, Back order, document stepping, picture gestures kept. e2e at 390 px (CDP touch).
- f. Room HWP preview, only if question 5 is a yes.

## Risks

- The image viewer's list gains chips: order and focus return with both kinds in one message; covered in b.
- Selecting and copying text in a PDF inside a focus-trapped overlay, and the desktop app's context menu there: e2e.
- c0's store change: new replies, edits, deletes and reactions must reach every open thread view (rooms-store tests).
- The side chat's PR 2 (removing @트리나) touches `Room.tsx`, `RoomComposer` and `RoomMessages` too: c0 and c go after it
  or rebase on it; a, b0 and d do not touch those files.

## Open questions for the owner

1. **The 스레드 · 트리나 switch on the room page too?** Recommend: in the viewer only for now. The room page keeps ✦ and
   the thread lines, one at a time, through the same component: no new control there.
2. **How Trina learns the file on screen.** Recommend: the question carries it, an optional `viewing: { fileId }` on the
   existing send body, taken only for a side chat of that room and checked with `room_file`'s read check; the server
   adds one line to that turn's side-room section ("the user has <name> open, file_id=…; 'this file' means it"). Nothing
   stored, no endpoint. The other way, writing the file id into the person's message, puts it in front of them to edit.
3. **팀 폴더에 저장: via Trina or a direct button?** Recommend via Trina: the item opens the Trina tab with "이 파일을 팀
   폴더에 저장해줘" filled in; the person sends it and `save_room_file` (PR #237) shows its card (where, who will see it).
   A direct button needs a new endpoint and its own wider-audience confirmation: later, if people use it.
4. **Chips without a preview (HWP, HEIC, zip, quarantined) download on a click today.** Recommend: the name opens the
   viewer too (card, download, thread, Trina, which reads an HWP's text through `room_file`), and the chip gets the
   download icon the other chips have, so one click still downloads.
5. **A room HWP/HWPX preview.** Recommend: a later PR (f) through the same HWP plugin with the member and quarantine
   checks; it is a new endpoint, so it needs your OK. Until then, the card.
6. **← → over pictures and documents together?** Recommend: yes, every file of the pane in message order, as Slack does;
   never other threads or older pages.
7. **크게 보기 remembered?** Recommend: no; it lasts while the panel is open.

## Result

Filled in step by step; the plan is done when c–e are.

### Step b: the viewer's document mode (`feat/room-file-viewer`)

Built as planned without the right column (docs/DECISIONS.md "The room file viewer"); PR
https://github.com/trina-app/trina-ax/pull/261. What differs or was found:
- **Item kinds:** `ViewerItem` gained `kind: 'file'`, its source `file` (the side panel's `PreviewFile`), `size`, `card`
  and `room: { roomId, fileId, messageId }`; not yet `rootId` or `threadable`, which step c adds with the column
  (`ViewerMeta` per message is where they come from). The room's name comes through `ViewerMeta` too (`where`).
- **The bar** has download, 패널에서 열기 (computers) and ✕; no ⋯ yet. 링크 복사 was left out: the app has room and
  message links (`?m=`), none that opens a file. 새 탭에서 열기 stays for pictures only. The time is the picture
  viewer's (date and time), not `formatRelative`.
- **Thumbnails, lazy pages and the bar's PDF zoom** are step d: the PDF keeps its own toolbar in the column now.
- **The column is 960 px at most**, in the app's light or dark surface on the dark backdrop (the panel's body, larger),
  so a Markdown or text file reads as in the panel; the wheel over the dark sides scrolls it.
- **Phones:** the bar never hides in document mode, ‹ › sit in it around "3 / 7" (the edge arrows would cover text), and
  a swipe steps where nothing under the finger scrolls sideways; picture mode is unchanged. Step e's sheet is still to
  come.
- **Deleted while open** is read from the message in the rooms store (`roomFileGone`), not from the chip leaving the
  page (the timeline goes back to its newest page on a resync); it covers room photos too, and ← → reach the nearest
  files still on the page, from the list as last seen. The items carry `room.messageId` for it (step c uses it too).
- **Shared answers:** a link to the attached copy still opens the side panel (a link, not a chip).
- **How step c slots in:** the stage spans the window under the bar and the column is centred in it, so the right column
  (`RoomSideColumn`, 400 px) narrows the stage from the right (`right-[var(--viewer-col)]`, the edge arrow moving with
  it), its toggle goes in the bar before ✕, and the thread follows `room.messageId` / `rootId` on each step.
