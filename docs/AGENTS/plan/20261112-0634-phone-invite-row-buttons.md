# Phones: the team invite link row, and the logo and Run now as rows

- Date (UTC): 2026-11-12 06:34
- Branch: `fix/phone-invite-row-buttons`
- Status: done
- Where: `web/` (this repo). Why: a phone layout of two Admin pages in the web app the phone app shows.
- Version impact: patch, a layout fix on phones only.

## Goal

QA TC-390: on a phone, Admin › Members & invites › Invite links squeezes the team invite link's details into a
column of single words ("폰 / QA · / 0 of / 20 · / Nov / 26, …") between its name and "Copy link only".

QA TC-382 item 4: Admin › Team settings › General shows an "Upload logo" outline button beside the logo, and › File list a
small "Run now" outline button under its text. On a phone each should be a row (or a full-width button), like the
Settings list.

## Scope

In (below 768 px only; computers and tablets keep what they have):

- The team link row as a phone row: the link icon, its name with Copy link only and ⋯ on the right, the details (groups,
  uses, until) on one or two lines under the name, as wide as the row. The same idea as Admin › System › Backups (#560).
- Team logo: the Upload / Change logo button becomes a list row across the screen (the upload icon, the words, the logo
  now on the right); Use the default logo another row under it when a logo is set.
- File list: Run now becomes a list row across the screen (the play icon and the words); while a run goes, the row
  says it is running.

Out: what any of them does (create, copy, revoke, limits, the local-address warning of TC-211, upload checks, the
file list's run and refusals); the single-use invite rows (they keep their one line, which fits); PR #574's rows on
the same General page (language, time zone) and AI engine.

## Steps

1. `pages/admin/Members.tsx`: a phone branch for the team link row (`useMediaQuery`, as Members does already).
2. `pages/admin/TeamSettings.tsx` `TeamIconRow`: on a phone, the buttons as `PhoneListRow`s in a list across the
   screen; the hidden file input and the error stay as they are.
3. `pages/admin/FileList.tsx` `FileListStatusLines`: on a phone, Run now (and the running line) as a `PhoneListRow`.
4. A phone e2e (390×844, touch; Chromium and WebKit) that follows the rows' steps; 1440 screenshots before and after.

## Risks

- PR #574 changes TeamSettings.tsx (language and time zone rows, DaysRow, the speech section): this stays inside
  `TeamIconRow`, away from its hunks.
- Test ids stay on the elements that act (`team-link-row`, `team-icon-upload`, `team-icon-remove`, `file-list-run`,
  `file-list-running`), so the existing tests keep working.
- No new words, so no i18n change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, and the new
`phone-invite-rows` e2e in Chromium and WebKit, with the existing `team-icon`, `admin-file-list`, `people-console` and
`team-link` e2e.

## Result

Built as planned, in https://github.com/trina-app/trina-ax/pull/580. The team link's details run under the name and
the buttons (the grid's columns 2–3), not only under the name: in Spanish the name column alone was about 115 px.
Upload logo and Run now are `PhoneListRow`s (rows, not full-width buttons), to match the Settings list. The 1440
screenshots before and after are byte-identical. The e2e `phone-invite-rows` passes in Chromium and WebKit; the
existing `team-icon` phone-width test fails the same way on `dev` (it clicks "Show previews", hidden on phones since
TC-269).
