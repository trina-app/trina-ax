# The desktop browser attaches team files to a page (file_upload)

- Date (UTC): 2026-11-26 12:53
- Branch: `feat/browser-file-upload`
- Status: done
- Where: shared/, server/, desktop/, web/. Why: the AI drives the desktop app's own browser, where the person is
  signed in, but could not put a team file into a page's file field (see docs/REPOSITORY-RULES.md)
- Version impact: minor: a new AI tool (file_upload) and a new desktop bridge version (BROWSER_BRIDGE_VERSION 1)

## Goal

The owner's real case: "reply to this Daum mail and attach the two PDFs and the business registration". The AI opens
Daum web mail in the desktop browser, where the person is signed in, but it could not attach a team file: the prompt
told it to say so. After this the AI attaches team files (and files sent in the chat) to the page's file field, the
person sees them in the page, and the page's own Send button sends them.

## Scope

In:
- Tool `file_upload {tabId?, ref?, coordinate?, files: [team path | team-file:<path> | chat:files/<name>], how?:
  auto|input|chooser|drop}`, kind mutates-tab (the site permit applies), not allowed inside browser_batch.
- Server: the team files read as for a mail attachment (team-attach.ts generalised: read permission, folders, the
  safety check, the same file twice, the stored-key scan) plus files sent in the chat; in a shared chat the file-read
  card of #647 (confirmSharedAttach) and its browser-change card. At most 20 files and 100 MB in one call.
- Single-use download tickets in memory (server/src/realtime/browser-uploads.ts): a random 32-byte id bound to the
  person and window, the exact bytes that were checked, expiring at the call's deadline, at most ~300 MB waiting on the
  whole server. `GET /api/browser/uploads/:ticket` (signed in, same person, the file checked again before it is
  served, octet-stream, no-store; every failure is 404).
- The step reads "파일 N개 첨부함: <host>" with the names; the audit line names paths, sizes and hashes.
- Older desktop apps: the page sends `pane=<BROWSER_BRIDGE_VERSION>` on /api/ws and the long-poll; the server lists
  file_upload only for a window that said 1 or more, and turns "Malformed browser call." into "update the desktop app".
- Desktop: fetch each ticket through the team page's session, check size and sha256, write it to
  `<app data folder>/<product>-up/<callId>/<i>/<clean name>` (0700/0600), then set it on the page: the file input behind the ref
  (also hidden inputs: DOM.setFileInputFiles), else the chooser the click opens (intercepted while the AI drives), else a
  drop. A one-file field and many files is an error. A computer click that opens a file chooser is suppressed with a
  hint. Temp files go when the tab closes, its site changes, the person changes, the app quits, at start, and over
  500 MB.
- `BROWSER_BRIDGE_VERSION = 1` (shared/src/desktop-bridge.ts) via bridge:info / preload / DesktopBridge.browser.version.
- Prompt: the browser rules say how to attach; ATTACH_HOW says the desktop browser can and Aside cannot.

Out: cross-origin iframes (a file field inside another site's frame), the Mac App Store sandbox build, folders.

## Steps

1. shared: tool name and desktop input schema, bridge version, ws/poll query `pane`, upload endpoint, step label.
2. server: browser-uploads.ts, the route, team-attach.ts generalised + chat files, browserTool's file_upload path,
   tool listing by pane version, prompt lines.
3. desktop: common/upload-files.ts (names, temp layout, sweep), pane file_upload (input → chooser → drop), chooser
   interception, cleanup, bridge:info/preload.
4. web: send `pane=` on /api/ws.
5. Tests (unit + desktop e2e), docs, changes file.

## Decisions

docs/decisions/20261126-browser-file-upload.md. Changes the "cannot attach" line of
docs/decisions/20261126-shared-chat-own-tools.md and docs/decisions/20261116-mail-attach-team-file.md's ATTACH_HOW.

## Risks

Security: no new card (the site is already allowed, the asker may read the file, hard blocks stay); the bytes leave
only to a page the person allowed, as their own upload would. A ticket is single use, short-lived and only the
person's. Old desktop apps never see the tool. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/e-browser-tools, new b-browser-upload and
e-desktop-upload-files under Bun 1.3.12, desktop e2e desktop/e2e/pane-upload.spec.ts.

## Result

Built as planned (docs/decisions/20261126-browser-file-upload.md). Differences:
- A ticket is checked against the person only; the window is recorded with it but not checked at the download (the
  desktop's main process, which fetches, does not know the page's window id). It is 256 random bits, single use and
  ends with its call.
- The leftovers of an earlier run are swept when the pane is made (one pane at a time), not separately at start.
- Chooser interception goes on at the AI's first acting call on a tab and off when no call runs.
- The tool texts name the button as "Attach" / "Add file" in English (Korean words outside the language tables fail
  tests/unit/i18n-languages.test.ts).
- The desktop e2e drives the WebSocket path only: the web app has no long-poll client; the server's long-poll query
  takes `pane=` (tests/unit/b-browser-upload.test.ts).

