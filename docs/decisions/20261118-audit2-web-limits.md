# Long pastes are never cut; audio, video and large PDFs preview from their address

- Date: 2026-11-18
- Status: accepted
- Supersedes: the preview limits of "tab 5" for audio, video and pictures (docs/DECISIONS.md, file preview)
- Branch: fix/audit2-web-limits (second limits audit N35 / QA TC-4985, N36 / QA TC-4986)

Plan: docs/AGENTS/plan/20261118-1700-audit2-web-limits.md.

- **Ask:** the AI should work like Claude Code, and a limit nobody needs is a bug. Two web limits were found: the ✦
  side chat's box cut a paste at 20,000 characters without a word (the main box and the API take 200,000), and the
  file preview said "This file is too large to preview" for audio and video over 60 MB, pictures over 20 MB and PDFs
  over 50 MB.
- **Rule, message text:** one constant, `MESSAGE_TEXT_MAX` (200,000, `shared/src/api/entities.ts`), for the send and
  edit schemas, the send queue and both AI boxes. No box has a `maxLength`. A paste that would take the box past it is
  never cut and never dropped: where the box takes files from this computer and has room for one more, the pasted text
  goes in as `Pasted text.txt` (every character) and a note says why; elsewhere (a shared project chat whose folder the
  person may not write, a message with 20 files already) the paste is refused with "A message can hold up to 200,000
  characters". A message past the limit at send (typed or dictated) is refused before it is sent, the text kept.
  The shared code is `useComposerFiles.onPaste` (components/chat/ComposerFiles.tsx) and `lib/longPaste.ts`.
- **Rule, preview:** `previewLimit(kind)` gets `stream`. Audio and video are never read into the window: the player
  gets the file's address and asks the server for parts (HTTP Range), so there is no size limit and playback starts at
  once. A PDF is still read whole up to 50 MB (kept for a quick return, as before); past it pdf.js reads it from the
  same address in parts (`disableAutoFetch`, `disableStream`: only the parts it draws). Pictures are drawn whole, so
  they keep a limit, raised from 20 MB to 100 MB. Word, PowerPoint and Excel files are parsed whole in the browser and
  keep 50 MB. Room files and shared file links (/f/) follow the same rules; the room's "too large" card only shows
  where a limit is left.
- **Security, unchanged:** the address is the one the file's own download and today's `<img>` previews use: the team
  file's `/api/files/download?disposition=inline` (read rules on every request, the download-only list through Fetch
  Metadata), the room's `/api/rooms/:id/files/:fileId` (members, checked on every read), the chat's
  `/api/chats/:id/files/:fileId`, the shared link's own download. Same origin, the cookie session, no key or token in
  the address, no new route, nothing kept by the browser (`private, no-cache`). Every route already served Range
  (`team-files/download.ts`, at most 8 MB a response). The app's CSP already allows `media-src 'self'` and
  `connect-src 'self'`; the service worker leaves `/api/` alone.
- **A file the player cannot play** (a codec the browser lacks, a refused address): "This file can't be played here.
  Download it to open it." with Download, as the card of a format with no preview.
- **Left out:** the room message box's own limit, the phone app's picker limits (N37), Office files without reading them
  whole.
- **Tests:** web `long-paste.test.ts`, `side-chat.test.tsx` (long paste becomes a file, no `maxlength`),
  `file-body.test.tsx` (players from the address with no fetch; a PDF past 50 MB streams, a deck past 50 MB is still
  too large), `lib.test.ts`, `image-viewer.test.ts`; server `c-files.test.ts` and `b-room-media-cache.test.ts` (a media
  read of a team and a room file in parts, 404 for someone who may not read it).
- **Version impact:** patch.
