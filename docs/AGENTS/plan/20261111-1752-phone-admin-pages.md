# Admin on phones, the level below each page: detail pages with an address, people and groups as pages, phone layouts

- Date (UTC): 2026-11-11 17:52
- Branch: `fix/phone-admin-pages` (into `dev`; #344 is merged there)
- Status: done
- Where: trina-ax core web (`web/src/pages/admin/`, `web/src/components/integrations/ConnectorsView.tsx`,
  `web/src/components/PageActions.tsx`, `web/src/components/PhoneFilters.tsx`, `web/src/components/CompactRow.tsx`).
  Why: phone navigation and the Admin pages are core web UI; the phone app is this web app in a web view (see
  docs/REPOSITORY-RULES.md and DECISIONS "Admin and Settings on phones: a list you tap into").
- Version impact: minor (a visible change on phones; no API, data or permission change).

## Goal

QA rows TC-267 to TC-270 (phone audit 2026-11-11). #344 made Admin's top level a list you tap into. The level below
each page is still desktop UI on a phone: detail views without an address (the iPhone swipe and ‹ jump to the Admin
list), rows that do nothing when tapped, anchored dropdown menus, and computer or server setup offered as phone forms.

Computers and tablets (768 px and up) keep their layouts.

## Scope

In (below 768 px unless said):

**TC-267, detail views get their own address; ‹ and the swipe go one level up**
- One table of Admin's parents, `pages/admin/adminScreens.ts`: `adminParent(path)` and `adminChain(path)` (the lists
  under a page opened from outside). AdminLayout uses it for ‹, its label and the list under a page. Written so that
  `lib/screens.ts` (#457, nav-model) can call it for `/admin/...` addresses.
- Connectors: a connector's page is `/admin/connectors/<id>` (Google Drive, Gmail, Calendar, Docs, Sheets, a listed
  service), on every width (the layout is unchanged on computers; the browser's Back now works there too). The old
  `?drive=1` and `?app=<id>` addresses lead there. On phones the card's own "← Connected apps" goes (the bar's ‹ is it).
- Plugins: a plugin's page is `/admin/plugins/<id>` on every width; `?focus=<id>` leads there. Its own "←" goes on phones.
- Folder permissions: choosing a folder pushes `?folder=` on phones (it replaced it); the rule editor is an entry of its
  own (`&rules=1`) under the phone bar ("‹" back to the folder, its name as the title) instead of a full-screen panel
  with its own 36 px ←. ‹ asks first when the rules were changed.
- Providers: on phones an engine is one row (name, state, chevron) that opens `/admin/providers/<engine>`: its state,
  switch and check, its accounts with Add account, and its details. Computers keep the accordion; `/admin/providers/<id>`
  there opens the row (`?engine=`).

**TC-268, Members and Groups rows open a page; their menus are action sheets**
- Row menus (`RowMenu.tsx`) and the ⌄ of page buttons (`PageActions.tsx`: Invite ⌄, Usage limits ⌄, Add ⌄) are the
  shared bottom sheet (`rooms/MenuButton.tsx`) on phones, destructive last. Computers keep the dropdowns.
- Members: a row opens `/admin/members/<id>`: the person's name, username and email, role, groups, the folders they see,
  last seen, and their actions as rows (destructive last).
- Groups: a row opens `/admin/groups/<id>`: description, members, Edit and Delete.
- Folder permissions › By person: the list alone, a person opens their page (the list goes); the segments' 44 px come
  with #453 (`Tabs`).
- Not touched: the Members invite-link section (TC-211, another session).

**TC-269, the remaining Admin pages use phone layouts**
- Plugins: flat rows like Connectors' Discover, its title once (the bar says it), "Install from file" as a 44 px icon
  button; a plugin's page with its name on its own line and the buttons under it.
- Activity log: a row opens `/admin/audit/<id>` (the record's details); the filters open in a sheet (`PhoneFilters`
  becomes a bottom sheet on phones, so Members, Folder permissions and Usage get the same).
- Usage: the breakdown as list rows (name and amount, the rest on a second line) instead of a 3-column table.
- Page intros: the description gets its own line(s) above the page's buttons instead of being cut beside them.
- The scope line ("Applies to everyone in Acme") once, on the Admin list; not repeated on every page on phones.
- The Admin list names the team's versions "Team AI accounts", "Team connected apps", "Team AI apps" (the 나 list has
  the person's own with the same names).
- Team settings › General: the logo's line in phone words (no "on the computer's sidebar"), its sidebar previews only on
  computers; the update window as two time pickers (start, end) instead of free text.
- Left: System (ADM-14, another session is changing its backup and storage parts). AI apps' rows are drawn by
  `integrations/AiAppConnect.tsx`, the settings agent's file (TC-262): left to them, said in the PR.

**TC-270, computer or server setup is not offered as phone forms**
- Slack: the token walk-through becomes a status row and "Set this up on a computer".
- Providers: an engine whose fix is a command on the server shows "Set this up on a computer" on phones, not the command.
- Connectors: adding a service by its address (the Add form, "Add one that is not listed") says to do it on a computer.
- Left: System's folder path (skip System); AI apps' terminal / CLI connect (AiAppConnect.tsx, settings agent).

Out: System, the invite-link section, any API or permission change, desktop layouts.

## Steps

1. adminScreens.ts, AdminLayout (sub-pages, the bar's title and a guard for ‹ from the page), Connectors and Plugins by
   address. Push, draft PR.
2. Folder permissions (folder and editor entries), Providers' engine page.
3. Sheets for row menus and ⌄; Members and Groups pages; By person.
4. Plugins rows, Activity log detail and filter sheet, Usage rows, page intros, scope line, "Team …" names, Team
   settings › General.
5. Slack, engines' server commands, add by address.
6. Phone e2e (`phone-admin-pages.spec.ts`, 390×844, owner / admin / member), the #344 phone specs, the touched desktop
   specs; checks; 1440 screenshots before and after.

## Risks

- Back order: a detail page opened from outside gets the section's list under it too (Admin → Connectors → Gmail). The
  list insertion (lib/backStack.ts) is unchanged; only the chain comes from the table.
- #457 (nav-model) changes the same `useListUnderPage` line in AdminLayout and adds `lib/screens.ts`, whose `/admin/...`
  parents should call `adminParent`. #432 changes three lines of Engines.tsx' EngineRow; this keeps away from them.
  #445 (AccessEdit comment), #450 (Plugins' rollback item), #454 (Members' reset link note), #421 (common.tsx'
  ReauthDialog), #431 (TeamSettings' AI defaults), #355 (AccessTree, Groups) touch other hunks of the same files.
- Desktop: Connectors' and Plugins' pages get an address on computers too (same layout); the old queries still work.
- Five languages for every new string; Korean in short 해요체.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`.
- e2e: new `web/test/e2e/phone-admin-pages.spec.ts` (390×844, touch); `phone-admin`, `phone-list-pages`,
  `phone-form-pages`, `phone-page-patterns`; the desktop specs of the touched pages (connectors, plugins, folders,
  members, groups, engines, activity log, usage, Slack, team settings).

## Result

PR #468. Built as planned, with these differences:

- Addresses: Members, Groups, Providers and Activity log items have their page on phones only; on a computer their
  address leads to the same thing in the page (`?member=`, `?engine=`, the list). Connectors' and Plugins' pages have
  their address on every width (same layout).
- The rule editor's entry is `&rules=<path>` (not `&rules=1`): a rule row outside the tree has no `?folder=` under it.
  Back closes the editor without asking (the browser gives no way to ask first, as before); ‹ in the bar asks.
- By person's segments get 44 px from Folders.tsx itself (a descendant rule), so this does not wait for #453's `Tabs`.
- `PhoneFilters` became a bottom sheet with Done, so Members', Folder permissions' and Usage's filters changed with
  Activity log's.
- AI apps' rows on phones are drawn in `admin/AiApps.tsx` (the shared `AiAppConnect.tsx` rows are the settings
  agent's): tappable rows, Claude Code and Codex marked "Set this up on a computer".
- Connectors on a phone have no Add (by address) button, so "Ask a member to connect" (in its ⌄) is a computer's too.
- Left: System as a list of pages (ADM-14) and System's folder path (another session is changing System's backup and
  storage parts); the address card of AI apps (`pages/AiApps.tsx` ConnectorAddress, the settings agent's).
