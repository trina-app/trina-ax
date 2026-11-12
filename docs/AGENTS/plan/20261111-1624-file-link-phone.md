# A file link opens the file at phone width

- Date (UTC): 2026-11-11 16:24
- Branch: `fix/file-link-phone`
- Status: done
- Where: trina-ax core (`web/src/pages/FileView.tsx`, a web unit test). Why: the file screen is core (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch, a link opens what it names on phones; no API, data or wording change

## Goal

QA TC-228 (from TC-155): at 390 px, `/files/view?path=shared%2FNotes%2Fmemo-final.txt` (the link the AI hands out)
ends on `/files?path=shared%2FNotes` with the folder list only; at 1440 the file opens in the preview panel. Reproduced
on a local server: at 390 the panel is not there and the tab has one history entry more than at 1440.

Why: `FileView` opens the panel in its effect while `<Navigate replace>` changes the address. React Router updates its
location in a transition, the panel store at once, so the panel is drawn first, on the old location. On a phone
`Layout` then holds a Back entry for the panel (`useBackCloses`, keyed by the location); when the new location lands it
lets go of that entry (`history.back()`) and holds a new one, and the late Back closes the panel.

After this change the panel opens once the files screen's address is in place, so it holds its Back entry there and
stays; Back closes it, as for a file opened from the list.

## Scope

In: `FileView.tsx` opens the file when the redirect is gone (the new route is drawn), not with it. A web unit test
(the panel opens only once the files screen is the route on screen).

Out: `lib/backCloses.ts` and `Layout` (another branch reworks the phone Back model; this keeps out of it).

## Steps

1. FileView: open the panel after the redirect unmounts (a StrictMode remount in development cancels the early one).
2. Unit test; check on a local server at 390 and 1440 px, with Back.

## Risks

No migration, no permission change, no wording. Desktop: the panel opens one tick later, on the same page. A folder
link is unchanged.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new unit test and the files tests in `web/test`.

## Result

Built as planned, in `web/src/pages/FileView.tsx` only. Its effect's cleanup (the redirect going away, which happens
when the router draws the folder's address) opens the panel one tick later; a second mount (React StrictMode in
development) cancels an early one. `lib/backCloses.ts` and `Layout` are unchanged.

Test: `web/test/unit/file-view-link.test.tsx` (the panel is first drawn when the folder's address is on screen, with
the link's place; it failed on the old FileView: the panel was drawn while nothing of the files screen was there; a
folder link opens no panel).

On a local server (Chromium): at 390 px the link opens the file's preview (before: only the folder, reproduced on the
same server); Back closes the preview and shows the folder; another Back goes to the page before. At 1440 px it opens
as before. `bun run typecheck` (web), `check:i18n`, `check:docs` pass. In a run of several web test files,
`phone-nav.test.tsx` "never pushes > no history state at all" fails after `back-closes.test.ts` and
`phone-me-files.test.tsx`, also without this change (it passes alone); not touched here.
