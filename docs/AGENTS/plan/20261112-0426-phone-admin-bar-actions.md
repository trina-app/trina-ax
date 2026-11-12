# Phones: Admin pages' main action in the bar, one search field with a Filters icon, roles as words in Members' rows

- Date (UTC): 2026-11-12 04:26
- Branch: `fix/phone-admin-bar-actions`
- Status: done
- Where: `web/` (the web app the phone app shows). Why: the phone app is one WebView of the web app, so its pages'
  phone layouts are web code (see docs/REPOSITORY-RULES.md).
- Version impact: patch, phone layout fixes with no new feature or API.

## Goal

QA TC-377, TC-379 and TC-382 item 3. The owner: "아직도 우리 모바일 화면이 많이 구린데… 아직도 데스크톱 화면이 그냥
단순히 모바일로만 된게 많은데". On a phone, Admin's pages still start with a computer's button block ("Invite to team ⌄",
"New group", "Add folder", "Usage limits ⌄", "Add limit", "Create") and a search with a "Filters" text button beside it.
A phone app has the page's main action in the bar (+, and ⋯ for the other ways), one full-width search field, and the
filters behind an icon.

## Scope

In (phones only, below 768 px; computers and tablets unchanged):

1. The Admin bar (AdminLayout.tsx `PhonePageBar`) gets a place on its right for the page's buttons (a portal slot, like
   Settings' `SettingsBarAction`). Each button 44 px with an accessible name.
2. Members: + invites (the invite dialog); ⋯ sheet: Add member, Team invite link. Groups: + New group. Folder
   permissions (By folder): + Add folder. Usage: + Usage limits; ⋯ sheet: Download CSV. Team settings › Usage limits:
   + Add limit. Team settings › Company profile: + creates the profile, "Edit" in the bar once there is one. No button
   block left at the top of these pages.
3. One full-width search field with the Filters icon inside it (count when a filter is set; opens the same sheet):
   Members, Activity log. Folder permissions: By folder / By person on its own line; By folder's Filters icon in the bar
   beside +; By person's search on its own line. Usage (no search): the range across the row with the Filters icon at
   its end. Groups: the search alone, full width (it already is).
4. Members' rows: the role as plain words. The role is still changed on the person's page (its Role row, the owner's
   select) and in the row's ⋯ › Edit.

Out: Plugins, System, AI apps and the back labels (another session, #560); the invite-link section's behaviour
(TC-211, only its button moves); rows TC-196–242, TC-266.

## Steps

1. `pages/admin/barActions.tsx`: the slot context, `AdminBarActions` (portal), `BarAdd` (+), `BarMore` (⋯ sheet through
   `rooms/MenuButton.tsx`). AdminLayout: provide the slot and render it as the bar's `action` (one line, apart from
   #560's back-label hunks).
2. `PhoneFilters`: an `icon` look (44 px, the count as a badge); `SearchBox`: an `end` slot inside the field.
3. Members, Groups, Folders (+ AccessTree's button and filter), Usage, Audit, TeamAiSettings (Budgets),
   CompanyProfileCard: on a phone the bar's buttons instead of the header's.
4. i18n: a name for the company profile's + (5 locales).
5. Phone e2e (Chromium and WebKit, 390×844, touch) per row; adjust the older phone specs that expected the buttons in the
   page; 1440 screenshots before and after.

## Risks

- #560 and #562 change `PhonePageBar.tsx` and `AdminLayout.tsx` (back labels, the bar's fit). This branch only adds the
  `action` prop's content and the slot provider; the bar's right side grows to 88 px with two buttons (still centred).
- A page that portals into the bar must not leave its buttons when an item's page is on show (a person, a group).
- Desktop: every change is behind the phone check; 1440 screenshots compare.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`; the new phone
spec (Chromium and WebKit) and the older phone specs these pages had.

## Result

Built as planned in PR #568. `pages/admin/barActions.tsx` holds the slot and the bar's +, ⋯ and words button;
AdminLayout only provides the slot (one `action` prop). Usage's + opens Usage limits (the split button's main action,
where that page's own + adds a limit); its ⋯ has Download CSV. Company profile: + while there is none, then "Edit".
Members' role is words in the rows; the person's page keeps the owner's select, and ⋯ › Edit the dialog. Folder
permissions' By person has no bar button (it had no Add folder before either). Tests: `phone-admin-bar.spec.ts`
(Chromium) and `phone-admin-bar.webkit.spec.ts` (WebKit), plus the older phone specs adjusted to the bar.
