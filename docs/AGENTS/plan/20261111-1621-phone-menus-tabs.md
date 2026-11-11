# Phones: menus open as bottom sheets; segmented tabs fit the width

- Date (UTC): 2026-11-11 16:21
- Branch: `fix/phone-menus-tabs` (stacked on `batch/phone-settings`, #344)
- Status: in progress
- Where: trina-ax/web. Why: the phone app shows the web app in a WebView, so phone menus and tabs are web code (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch. Phone layout fixes; computers and the API are unchanged.

## Goal

The owner's iPhone QA (TC-249, TC-250): menus on phones are small dropdowns by the finger, a different one on each
screen, and the Team skills tabs scroll sideways with a scrollbar ("위에 스크롤바 뭐여"). On phones every menu below
opens as the same bottom action sheet (`components/rooms/MenuButton.tsx`), and segmented tabs fit the width.

## Scope

In (below 768px only; computers and tablets unchanged):

- TC-249 menus as bottom sheets:
  - the chat / project / scheduled task title ⌄ (`TitleMenu.tsx`)
  - Team skills row ⋯ (`AvailableSkills.tsx`), without the monospace path; the review sheet's Preview / Edit toggles
    at 44px
  - Scheduled tasks: "+" in the bar opening a sheet instead of "새 작업 ⌄"; a task's actions as rows with a red
    Delete row last
  - the Trina drawer's cascading filter menu (`Sidebar.tsx`)
  - search result row ⋯ (`SearchDialog.tsx`): a 44px ⋯ and a long press open a sheet; no pre-highlighted first row
    on touch
  - MenuButton's sheet (visual only, same props): 48px rows, destructive rows last, a Cancel row
- TC-250 segmented tabs:
  - `Tabs segmented` (`ui.tsx`): equal-width segments that fit the row, 44px tall, no sideways scroll or scrollbar;
    more than 3 choices fall back to a picker row that opens a sheet
  - Team skills tabs, Activity tabs and its tools row (filter chip, 44px buttons), the search overlay's type chips;
    every other `Tabs segmented` checked at 390px in Korean and English

Out: Files row ⋯, Projects ···, Admin menus, the composer's engine picker (other agents); SearchDialog open / close /
Back and MenuButton's Back hook (overlay-back); shared 44px defaults in `ui.tsx` (TC-189).

## Steps

1. MenuButton sheet polish (Cancel row, destructive last).
2. TitleMenu on phones through MenuButton; Scheduled bar "+" and task menu.
3. Team skills ⋯ and review toggles; Sidebar filter menu; SearchDialog row ⋯ and chips.
4. `Tabs segmented` fit and picker fallback; Activity tabs and tools row.
5. Phone e2e at 390×844 in ko and en for each screen; 1440 screenshots before and after.

## Risks

- Desktop must not change: every change is under `max-md:` or a `(max-width: 767.98px)` media query.
- Other agents edit SearchDialog (open / close / Back) and MenuButton (a Back hook) at the same time: keep to the chips,
  the rows and MenuButton's look.
- Five app languages: new words in en, ko, id, ja, es.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`; new phone
e2e `web/test/e2e/phone-menus-tabs.spec.ts` (390×844, touch, ko + en).

## Result

Filled in at the end.
