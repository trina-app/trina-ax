# Sidebar shows the team logo; no focus line along the sidebar

- Date (UTC): 2026-11-07 08:07
- Branch: `fix/sidebar-team-logo-main-focus`
- Status: done
- Where: this repo, the web app (`web/src/components/`). Why: both are bugs in the app's own UI.
- Version impact: patch (two UI bug fixes, no API or data change)

Written after the work started: the plan-first rule (docs/AGENTS/README.md) reached `dev` while this branch was
being tested, so this plan records what was decided and done.

## Goal

Two reports from the team's own server:

1. An admin set a team logo (Admin › Team settings › Team logo), but the icon next to the team name at the top left
   of the sidebar stayed the product mark. The logo only reached the browser tab, the sign-in page and the home-screen
   icon.
2. A full-height orange line sometimes showed along the sidebar's right edge. It is the global `:focus-visible`
   outline drawn around `<main id="main" tabIndex={-1}>`: clicking an empty spot in the page focuses `main`, the next
   key press makes the outline visible, and only its left edge is on screen, over the sidebar border.

## Scope

In:

- The sidebar header on a computer shows the team logo (`/team-icon?v=<iconVersion>`, the same URL rule as the
  settings preview) when one is set, and the product mark when not. It changes without a reload when an admin
  uploads or removes a logo (`/api/me` is read again).
- On phones the drawer header names the AI, not the team, so it keeps the product mark.
- `main` draws no focus outline (`outline-none`). The global focus style and every control inside `main` keep their
  outline; the skip link still moves focus to `main`.
- `teamIcon.desc` in the five languages names the sidebar; CHANGELOG, DECISIONS ("Team logo as the tab icon") and the
  guide say where the logo shows.

Out:

- Other `tabIndex={-1}` elements (headings and dialog containers): checked, none draws a line like this.
- Loading the logo only on wide screens (a hidden image still downloads on phones; it is cached for good).

## Steps

1. `Sidebar.tsx`: the header image picks the team logo or the product mark; on phones the product mark.
2. `Layout.tsx`: `outline-none` on `main`.
3. Texts and docs as above.
4. Tests: sidebar unit tests (logo, new version, no logo, phone); `team-icon.spec.ts` (sidebar after upload and
   after removal, a wide logo is cropped, the phone drawer keeps the mark, `main` has no outline while a button inside
   still has one).

## Risks

- No migration, no permission or API change.
- Accessibility: `main` is only a focus target, not a control; the next Tab lands on a control that shows its ring.
- Five app languages: one string changed in each.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web` (also in Docker with bun 1.3.12
as CI runs it), `bun run build:web`, and the full web e2e (chromium).

## Result

Built as planned. Before the fix the orange line was reproduced (click an empty spot in the page, press Shift);
after it, the same steps leave no line. An independent review found no must-fix.

On `dev` at a6c353f4: web unit 1573 pass / 0 fail (also in Docker), full web e2e 733 passed / 12 failed /
7 skipped. The 12 failures fail the same way on clean `dev` (two team-skills a11y checks; sign-in and sign-out
cases in auth, offline, rankings, source-code, states and upload-progress), so none comes from this change.
