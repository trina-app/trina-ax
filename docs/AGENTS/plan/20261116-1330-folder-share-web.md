# Folder sharing, the web part (PR 5 of the folder-sharing design)

- Date (UTC): 2026-11-16 13:30
- Branch: `feat/folder-share-web` (from `feat/folder-share-server`)
- Status: built, gate closed (pushed; no PR yet)
- Where: Team AX core (`web/src/components/FileShareDialog.tsx`, `web/src/pages/FileLink.tsx`,
  `web/src/pages/SharedFiles.tsx`, `web/src/pages/Files.tsx`, `web/src/components/FolderAccess.tsx`,
  `web/src/pages/admin/`, `web/src/i18n/*`, `web/test/mock/server.ts`, `shared/src/api/auth.ts`,
  `server/src/auth/service.ts`, `docs/site/`). Why: files, permissions and sharing are core (docs/REPOSITORY-RULES.md).
- Version impact: minor (screens for a new feature; one optional field on `Me` and one on the person's preferences).

## Goal

The design is `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`, revision 2), section
"Web" and PR 5. The owner approved: like a folder in Google Drive's My Drive, view only, one Share dialog for files and
folders.

## Scope

In:
- One switch in code for the rollout gate (`FOLDER_SHARES_OPEN`, closed) and `Me.server.folderShares`, so the web
  shows nothing of folder sharing while it is closed.
- Files: Share on a folder in My files opens the file Share dialog; no Share on the personal folder itself or a place
  Trina keeps; the "Shared" chip on a shared folder and on what is inside it ("Shared through Work").
- The dialog for a folder: what it holds, the line that later files follow, the Everyone line for folders, the saves
  line (`wideSavesOn`), why it can't be shared (`blocked`), Paused + Resume, the folders above it that share it
  (`through`), Stop sharing that names what stays shared on its own (files and folders, M5), Undo (server undo).
- The receiver: Files › Shared with me lists folders; `/f/<id>` shows a read-only folder (one level a call, a file opens
  in the page's file view); a paused or closed folder says it is not available.
- Notices: "Mina shared a folder with you: Work"; the owner's paused / ended rows.
- Admins: the team switch says "files and folders"; Remove all counts folders apart; a one-time line on Admin › Home.
- The mock server's folder-share endpoints as `shared/src/api/file-shares.ts` defines them.
- Six languages; user docs; changelog fragment.

Out: the widening hook (PR 3), the AI tools (PR 4, 6, 7), Ask an admin (PR 7), the move/restore confirms' new counts
(they come from PR 3's server answers; the web already shows the existing confirm).

## Steps

1. The gate switch, `Me.server.folderShares`, the mock's endpoints and fixtures.
2. The dialog, the Files menu and chips, the link page, Shared with me, notices, admin.
3. Words in six languages; web unit tests; the Playwright spec; screenshots.
4. Hands-on pass on a private copy of the QA team with the gate opened locally.
5. Docs, changelog fragment, QA rows.

## Decisions

None new: the design's rules. The gate stays closed in code until the manager says.

## Risks

- PR 3 (widening) must merge before the gate opens: until then a save into a shared folder does not warn.
- `cantAsk`'s words change for files too ("You can't open this right now"), because a receiver must not learn whether
  a link is a paused folder or a file.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `cd web && bun test test/unit/folder-share*.test.tsx`,
`bunx playwright test test/e2e/folder-share.spec.ts` (and the existing file-share and Shared with me specs).

## Result

- Built as scoped. The gate is one line, `FOLDER_SHARES_OPEN` in `server/src/files/folder-share-gate.ts` (closed);
  `Me.server.folderShares` carries it to the web, and with it closed every screen is as before (unit and e2e tests).
- Departures from the design: a file inside a shared folder opens at `/f/<id>?f=<path inside>` (a folder at `?p=`), so
  the page knows which call to make; the header line inside a shared folder ("Shared with Jun and 2 others · Manage") is
  the breadcrumb chip's accessible name and title instead of a second line (lean UI); a hidden name inside a shared folder
  gets no "Shared" mark (receivers never see it; the server's `entryMarks` marks it, worth fixing there); the receiver's
  closed-card words changed for files too ("You can't open this right now"), so a paused folder and a file read alike.
- Checks: typecheck, check:i18n, check:docs, features:check, web unit `folder-share.test.tsx`, server unit
  `c-folder-share-web.test.ts`, e2e `folder-share.spec.ts` with the existing file-share and Shared-with-me specs, and a
  hands-on pass on a private copy of the QA team with the gate opened locally (QA TC-4077..4089).
