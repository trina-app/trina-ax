# Long pastes are never cut, big media and PDFs preview by streaming

- Date (UTC): 2026-11-18 17:00
- Branch: `fix/audit2-web-limits`
- Status: in progress
- Where: web/ and shared/ (Team AX core). Why: both limits are in the web client of the core chat and file screens.
- Version impact: patch, two limits removed from the web client, no API change.

## Goal

Second limits audit, items N35 (QA TC-4985) and N36 (TC-4986).

- The side chat's box cut a paste at 20,000 characters without a word; the main AI box and the API take 200,000.
- The file preview refused audio and video over 60 MB, pictures over 20 MB and PDFs over 50 MB, because it read the
  whole file into memory first, although every file route already serves HTTP Range.

## Scope

In:

1. One constant `MESSAGE_TEXT_MAX` (200,000) in `shared/src/api/entities.ts`, used by the send / edit schemas and the
   queue. The side chat box loses its `maxLength`. A paste that would take either AI box over the limit is never cut:
   the pasted text is attached as a text file (`Pasted text.txt`) where the box takes files, and a note says so;
   where it takes none (or the message is full of files) the paste is refused with a message. A message over the
   limit at send (typed or dictated) is refused before it is sent, the text kept.
2. Preview: audio and video always play from the file's address (the browser asks for parts with Range; no size cap,
   playback starts at once). A PDF up to 50 MB is read whole as before; a larger one is read by pdf.js in parts from
   the same address. Pictures: 20 MB → 100 MB (they are drawn whole). Office files keep 50 MB (parsed whole in the
   browser). The same addresses and the same cookie session as today's `<img>` previews: no new route, no token in an
   address.

Out: room message box limits, the phone app's picker limits (N37), Office streaming.

## Steps

1. Shared constant, schemas, queue; long paste in `useComposerFiles.onPaste`; send check in both boxes.
2. `previewLimit` gets `stream`; `useFileBlob` returns `stream` (an address) for media and big PDFs; FileBody,
   PdfView, MediaView and the shared-link page read from it; room-file checks (`roomNoPreview`) follow.
3. Tests, i18n in all languages, decision file, changes note, screenshots.

## Decisions

- `docs/decisions/20261118-audit2-web-limits.md`.

## Risks

- A media element or pdf.js reads the address without the window header: the same as `<img src>` previews today
  (cookie session, same origin, Fetch Metadata checks unchanged).
- iPhone app web view: media requests carry the cookie (WebKit network process); an error shows the download card.

## Tests

`bun run typecheck`, web unit tests for preview limits and the long paste, `bun run check:prepush` (Bun 1.3.12).

## Result

(filled in at the end)
