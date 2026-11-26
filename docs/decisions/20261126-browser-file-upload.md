# The desktop browser attaches team files to a page (file_upload)

- Date: 2026-11-26
- Status: accepted
- Supersedes: "Rule, what cannot attach" of [20261126-shared-chat-own-tools.md](20261126-shared-chat-own-tools.md) for
  the desktop app's in-app browser (apps on the computer such as Aside still cannot attach), and "A file upload tool for
  the browser is left for later" there; ATTACH_HOW of [20261116-mail-attach-team-file.md](20261116-mail-attach-team-file.md)
- Branch: feat/browser-file-upload (the owner, 2026-11-26)

- **Ask:** the owner's real case: reply to a vendor in Daum web mail, signed in in the desktop app's browser, with two
  PDFs and the business registration from the team folder. Trina could open the mail and write the reply but had to say
  it cannot attach files.
- **Rule, the tool:** `file_upload {tabId?, ref?, coordinate?, files, how?: auto|input|chooser|drop}`. `files` names team
  files (a team path as glob or list shows it, or `team-file:<path>`) or files sent in this chat (`chat:files/<name>`), in
  order, at most 20 files and 100 MB in one call. Kind mutates-tab: the desktop's site permit applies before anything is
  fetched. Not in `browser_batch` (refused on the server and in the desktop). Listed only for a window whose desktop app
  runs it.
- **Rule, the files:** the server reads each file as the person of the turn with the checks of a mail attachment
  (`team-attach.ts` `readOutgoingTeamFiles`: read permission, no folder, the safety check, the same file twice, the
  limits, a stored connection key inside the file) and chat files through the chat's one filtered list (not one carried
  by a hidden answer, not held). The desktop app never sees a path: each file becomes a ticket (`realtime/browser-uploads.ts`):
  32 random bytes, bound to the person (and recorded with the window), single use, holding the exact bytes that were
  checked, ending at the call's deadline or when the call ends, at most ~300 MB waiting on the whole server (more is
  refused, not queued). `GET /api/browser/uploads/:ticket`: signed in, the same person, the file checked again (access
  now, unchanged, not held), `application/octet-stream`, `no-store`; every failure is the same 404.
- **Rule, no new card:** the site is one the person allowed, the person may read the file, and the hard blocks stay, so
  a file going to that page is what the person's own pick would do (Rule A; AI should match Claude Code). In a shared
  chat the browser's notice and change card of #647 apply, and a team file some people there cannot open gets the
  asker's file read card first (`confirmSharedAttach`): no attaches nothing and says so in one plain line. Auto mode
  (20261125-auto-mode.md) treats it as the other browser tools that act: every card it can meet (the site cards, the
  shared read card, the browser change card) is `ask`, so auto mode lets nothing through on its own.
- **Rule, the desktop:** it fetches each ticket through the team page's own session, checks size and sha256 and writes
  the file to `<temp>/<product>-up/<callId>/<i>/<clean name>` (folders 0700, files 0600; the name NFC, without the
  characters and names Windows refuses, at most 120 characters with its extension: `common/upload-files.ts`). Then, in
  order: the file field behind the ref (also a hidden one, a label's control, the only file field near a button):
  `DOM.setFileInputFiles`, read back; else the file picker the ref's click opens (choosers are intercepted only while
  the AI drives, so no system window opens), set the same way; else a drop there (`Input.dispatchDragEvent`). A one-file
  field and many files is an error. A computer click that opens a picker gets it closed and the AI is told to use
  file_upload. The files stay on disk while the page may still upload them (a web mail uploads on Send) and go when the
  tab closes or moves to another site, the person signed in changes, the app quits or starts again, and over 500 MB the
  oldest calls go.
- **Rule, older apps:** `BROWSER_BRIDGE_VERSION = 1` (`shared/src/desktop-bridge.ts`) through `bridge:info`, the preload
  and `DesktopBridge.browser.version`. The page sends it as `pane=` on `/api/ws` (and the long-poll's query); the hub
  keeps it per window and the server lists file_upload only where it is 1 or more. The prompt then says how to attach;
  without it, to update the desktop app. An old app that still gets the call ("Malformed browser call.") becomes the
  same plain "update the desktop app" for the AI. A changed `*_BRIDGE_VERSION` ships the Windows app at once
  (docs/RELEASE-CI.md, the Windows rule of #629).
- **What the person sees:** the step "파일 첨부 · a.pdf, b.pdf", then "파일 2개 첨부함: mail.daum.net · a.pdf, b.pdf";
  the audit line names each file's path, size and hash, never its content.
- **Left out:** a file field inside another site's frame (cross-origin iframes), the Mac App Store sandbox build (not
  tried), folders, pasting files.
- **Tests:** `tests/unit/b-browser-upload.test.ts`, `tests/unit/e-desktop-upload-files.test.ts`,
  `tests/unit/e-browser-tools.test.ts`, `desktop/e2e/pane-upload.spec.ts`.
- **Version impact:** minor (a new AI tool and a new desktop bridge version).
