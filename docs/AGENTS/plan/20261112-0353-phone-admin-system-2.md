# Phones, Admin follow-ups: tidy backup rows, AI apps setup on a computer, every ‹ named, a plugin's page alone

- Date (UTC): 2026-11-12 03:53
- Branch: `fix/phone-admin-system-2`
- Status: done (PR #560)
- Where: `web/` (pages/admin). Why: the phone app shows the web app; these pages' phone layouts are web code.
- Version impact: patch, phone layout only; computers unchanged

## Goal

Follow-ups from testing #551 on a real server at 390×844 (WebKit and Chromium), owner signed in:

1. QA TC-269 step 1: Admin › System › Backups: each row's date was crushed into one word per line because the badges
   and Restore took the row's width. On a phone the row is a tidy list row: the date and size on the first line, the
   badges under it (wrapping), Restore on the right (44 px tap area).
2. QA TC-270 step 3 (ADM-15): Admin › AI apps with the connector off on the server showed the installer flag, the
   server.json line and the environment variable to copy. On a phone: the Off status and "컴퓨터에서 설정해요" with one
   line, like connected folders and connection in #551. The app rows stay.
3. An engine's page (`/admin/providers/claude-code`) showed ‹ with no name: "Team AI accounts" did not fit beside a
   long title, so the bar hid it. Every `/admin/<section>/<sub>` page names the page it returns to. QA TC-381 adds Team
   settings' "Members and AI" and "Company profile" (same cause).
4. QA TC-269 step 2: a plugin's own page on a phone still had the plugin search box and the upload button above it.
   The page shows the plugin only; the list keeps them.

## Scope

In:
- `System.tsx` Backups: the phone row layout only (no change to backup or restore behaviour, TC-208/221).
- `AiApps.tsx` (admin): on a phone the setup commands become the status plus the "set this up on a computer" line.
- The ‹ label on Admin's item pages (`AdminLayout.tsx` / `PhonePageBar.tsx` as needed), with an e2e check that the
  label is shown (not only in the DOM) on each kind of item page.
- `Plugins.tsx`: the search row is not on a plugin's page on a phone.
- Strings in 5 locales, phone e2e (Chromium + WebKit), 1440 screenshots before/after, changes fragment.

Out: backup/restore logic and `server/src/system/ops.ts` (TC-208/209), Admin › Connectors › Google Drive (TC-266).

## Steps

1. Plan (this file).
2. Backups row, AI apps, plugin page; the ‹ label.
3. e2e in `phone-admin-system.cases.ts` (Chromium + WebKit); computer screenshots; checks; PR.

## Risks

Phone layout only; computers keep their markup. `PhonePageBar` is shared by every phone page: a change there must keep
the title centred where it already fits and is checked on the pages that use it.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, the phone
e2e specs for Admin (Chromium and WebKit).

## Result

- Backups: a phone branch of the row (date and size, badges under it, Restore on the right); computers' markup as before.
- AI apps: with the connector off a phone shows Off and "컴퓨터에서 설정해요" with `admin.onComputerAiApps` (5 locales); the
  setup lines stay on computers (`ConnectorOff` unchanged).
- ‹ label: every Admin page already had the parent's name; the shared bar hid it when it did not fit beside the centred
  title. `PhonePageBar` now lays out in three ways (`barFit`): centred title, else the label whole and the title in the
  room left, else ‹ alone. `pageName` is exported and unit-tested over every pushed Admin address.
- Plugins: the title row is not drawn on a phone's plugin page.
- Tests: `phone-admin-system.cases.ts` `systemFollowUps()` (Chromium + WebKit), `test/unit/admin-back-names.test.ts`.
  1440 screenshots before and after differ only in "checked at" times. PR: #560.
