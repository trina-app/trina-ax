# Share dialog: Limit access says what it does, or why it does nothing

- Date (UTC): 2026-11-25 10:44
- Branch: `fix/folder-restrict-honest`
- Status: in progress
- Where: web/ (Share dialog, `web/src/pages/admin/FolderSharing.tsx`) and the six locale files. Why: the dialog is the
  admin's Share panel in Files and Admin › Folder permissions (see docs/REPOSITORY-RULES.md)
- Version impact: patch. The dialog shows and words things differently; what the server saves and checks is unchanged.

## Goal

The owner opened Share on `shared/Finance` ("전사 공유" › Finance). The folder has no setting of its own, and the
company-wide folder above it lets in only the owner and admins. Turning **Limit access** on or off changed nothing on
screen, because it changed nobody: Limit access stops people the folders above let in, and the folders above let in
nobody but the owner and admins, who keep access anyway. The dialog never said so. Also the General access line read
"팀장과 관리자만 열 수 있어요. · '전사 공유'에서 · 거기서 바꾸기", and the Korean mixed 합니다체 and 음슴체 into 해요체.

The owner also asked why "전사 공유" can be admins only. Read from the code: a new team's `shared/` is "everyone can
edit" (`createDefaultFolders`); setup, the AI's folder tool (never General access or Limit access) and migrations do
not restrict it. Only an admin's choice in this dialog or Admin › Folder permissions does, or the one-time "access adds
up" conversion that kept an older team's stricter setting. The QA server's `shared/` is open (read-only check of its
rules and audit rows). So the dialog must make a restricted "전사 공유" read as an admin's choice, with one way to change
it.

## Scope

In:
- Limit access when it changes nobody now (the folders above let in only the owner and admins: the server's `above`
  answer has no rule row that opens it): the switch is shown greyed with one line why, in place of the long hint. It
  works again by itself when the folder above opens to someone.
- Limit access when it matters: turning it on lists the people it stops under "Access removed" at once (from the
  server's answer for the draft, with Add), not only after Save; the rows from the folders above leave the list and the
  General access line follows (already so).
- General access, a folder with no setting of its own: the hint on its own line, then "Follows '<folder>' · Change
  there ›" on the next (no "· 'X'에서 ·").
- `shared/` itself when Restricted: one line "Company-wide is usually open to the whole team. An admin restricted it."
- Korean: every sentence of the dialog in 해요체 (hints, row lines, Limit access, the notice); labels stay short.
- All six locales get the new keys.

Out: server rules and saves (unchanged); the admin notice after the conversion beyond its wording.

## Steps

1. `limitIdle` from `data.above` (only rule rows with access and people count); `LimitAccess` gets `idle`.
2. Draft "Access removed": people who lose access in the preview while the limit is turned on in this draft.
3. General access follow line and the `shared/` note; new keys `folderAccess.followsFolder`, `followsTop`,
   `limitIdle`, `sharedRestricted` in en and the five other locales.
4. ko wording to 해요체.
5. Tests: panel unit tests for each state (parent open / restricted, people added or none, subfolder / top folder,
   shared/ itself, member view refused); server save test that the limit still saves and cuts exactly who the preview
   named. Screens at 1440 and 390, light and dark, on a private local server with test data.

## Decisions

None new: Limit access works as docs/DECISIONS.md "Folder access adds up like Google Drive (P2)" says; only what the
dialog shows changes.

## Risks

Words in six languages; tests that compare old keys. No migration, no permission change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, `web/test/unit/folder-sharing-panel.test.tsx`,
`tests/security/folder-sharing.test.ts`, web e2e `folder-access.spec.ts`.

## Result

(at the end)
