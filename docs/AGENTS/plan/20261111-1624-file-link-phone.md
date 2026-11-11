# A file link opens the file at phone width

- Date (UTC): 2026-11-11 16:24
- Branch: `fix/file-link-phone`
- Status: in progress
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

(filled in at the end)
