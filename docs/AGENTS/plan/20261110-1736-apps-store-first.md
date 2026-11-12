# Settings › Apps: the Mac row offers the App Store first

- Date (UTC): 2026-11-10 17:36
- Branch: `fix/apps-store-first`
- Status: done
- Where: trina-ax core (web `lib/apps.ts`, `components/settings/AppList.tsx`). Why: the page is core UI; the edition's
  links stay in `editions/trina/branding/apps.json` and do not change (see docs/REPOSITORY-RULES.md)
- Version impact: patch, one settings row offers its two ways in the other order; no server, API or data change

## Goal

Settings › Apps (#325): when the team server has its own Mac installer (.dmg), the Mac row offers that file and not the
App Store. The file brings a macOS security warning the first time and does not update by itself. The owner decided the
App Store comes first on the Mac row: no warning, and it updates by itself. The server's installer stays as a second
way, folded under the row, only when the server has one.

The same follow-up records a second owner decision in docs only: who the admins are is not secret (#304's open question).

## Scope

In:
- `computerApps`: the Mac row with an App Store listing offers it; the server's Mac installers go in the row's `more`,
  shown under a small "Download the installer" fold (⌄) with the install steps (Gatekeeper) inside it.
- Unchanged: the Mac App Store build ("This app" with the store's line, no installer anywhere); the desktop app from the
  team server on a Mac (its own row offers only the server's installer: the store build is another app with its own
  data); the Windows row (its installer first, no Microsoft Store listing yet); an edition without a Mac listing (the
  installer first, as before).
- One new string in ko, en, id, ja, es; unit test for the order with and without a server installer; apps-install e2e
  at 1440.
- DECISIONS: #325's entry amended; #304's and #341's open question closed (admin identity is not secret).
- `changes/apps-store-first.md`.

Out: the Windows row and a Microsoft Store listing; any change to who counts which admins (#304's protections stay).

## Steps

1. Plan (this file).
2. `lib/apps.ts` (`more`), `AppList.tsx` (the fold), i18n.
3. Unit and e2e tests; DECISIONS; changes file.

## Risks

No migration, no API. App Review 2.4.5: the Mac App Store build still offers no installer (`c.store` empties the
files before the row is built). The iPhone app's Mac row already offered the server's .dmg; it now offers the App Store
first and the .dmg folded.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `web/test/unit/apps.test.ts` and
`web/test/unit/downloads.test.ts`, `bun run test:web`, `bun run build:web`, `web/test/e2e/apps-install.spec.ts`.

## Result

Built as planned, PR #343. The Mac row's second way is a `<details>` fold under the row ("설치 파일 내려받기 ⌄"),
closed by default, with the file buttons and, on a Mac, the install steps inside it; the chevron follows the label, as
the owner's "Download installer ⌄" put it, and the text is small because it is the second way. The independent review
found no must-fix item; from it: the unit test also checks the file and the warning sit inside the fold, DECISIONS says
the warning comes with an unsigned file, and the edited paragraphs are wrapped. Left for later: the user guide's Mac
install section still describes only the .dmg.
