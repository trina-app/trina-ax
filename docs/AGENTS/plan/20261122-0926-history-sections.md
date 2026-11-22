# Trina history: my sections, foldable groups and one menu, as Claude Code's session sidebar

- Date (UTC): 2026-11-22 09:26
- Branch: `feat/history-sections`
- Status: draft (waiting for the plan review)
- Where: web (`components/panels/TrinaList.tsx`, `panels/TrinaPanel.tsx`, `nav/HistoryList.tsx`, `nav/ChatItem.tsx`,
  `nav/SidebarSections.tsx`, `nav/NavFolders.tsx`, `phone/TrinaDrawer.tsx`, `store/navFolders.ts`), shared
  (`api/entities.ts` UserPrefs), server (`chat/nav-folders.ts`, one rule). Why: the Trina list is core, and the
  sections reuse the Chats sections code (docs/REPOSITORY-RULES.md).
- Version impact: minor (a new feature in the Trina list and a new preference on `/api/me`; nothing removed).

## Goal

The owner, with a screenshot of Claude Code desktop's session sidebar: "우리도 이런거 도입해야할듯?". There a person
makes their own sections at the top of the list (each folds with ▾ and holds the sessions they put there), then the
date groups (Today, Yesterday, Nov 18, Older) fold too, and one menu has Group by, Sort by, Show, New section, Reset to
defaults and View all.

For Trina: each person sorts their own Trina history into **sections** ("섹션"), the same concept, name, menus and
drag as the Chats sidebar's sections (docs/decisions/20261121-personal-sidebar-sections.md), and the one filter menu
that is already in the Trina header gets the same shape as Claude Code's. One concept, one name, everywhere.

## What we have and what is new

| Claude Code | Trina today | This change |
|---|---|---|
| User sections at the top | Chats (대화) has per-person sections (nav folders kind `rooms`). The Trina list had its own folders (kind `chats`, 11-13) and the owner dropped them from the screen on 11-13 (`TrinaList.tsx` header); the server still keeps them (tables, routes, `GET /api/chats/groups` `folders`, `fileChat`) | **New on screen**: kind `chats` comes back, drawn and named as **sections** with the Chats sections' UI |
| New section | Chats: in the Channels "+" menu and "New section…" in Move to section | In the history menu, and "New section…" at the end of Move to section |
| Drag / Move to section | Chats: drag (`dragRow`/`useDropTarget`) and the row's Move to section / Remove from section (`useSectionRowItems`) | Same on a Trina row (`ChatItem` "⋯", phone long-press sheet, the chat header "⋯"), toast with Undo |
| Collapse a section | Chats sections fold (`PanelSection` foldKey, kept in `prefs.listFolds` on every device) | Same, key `folder:<id>` |
| Group by Date / Folder / Status / Environment / None | Group by None (default since 11-14) / Date / Project; Status is a filter (Active, Answering or waiting for you, In a project, Not in a project, Confidential) | Keep None / Date / Project (our "Folder"). **No Status grouping, no Environment** (see cuts) |
| Date groups fold | Date and project headers in `HistoryList` do not fold | **New**: date headers fold, as project headers already do in `HistoryGroups` (fold kept in `listFolds`) |
| Sort by Last updated / Created | Last activity / Date created / Title | Unchanged |
| Show | Status (above) and Last activity (All, Today, 7 days, 30 days) | Unchanged; the two stay as they are, under the name they have. No "archived" (chats have no archive; deleted ones are in 삭제한 기록, which keeps its place in the "⋯") |
| Reset to defaults | the "×" on the filter line above the filtered list | **New**: a "Reset to defaults" row at the end of the menu (only while something differs), the "×" stays |
| View all | The panel caps a grouped view (5 projects × 3 rows, "Show all projects") | **Cut** (see cuts) |
| Settings on every device | the view is in localStorage per browser; folds already per person on the server | **New**: the view goes to `prefs.historyView` (per person, every device) |
| Phone | the drawer and 트리나 tab use the same `RecentsMenu` as bottom sheets | Same menu with New section and Reset to defaults; sections show in the 트리나 tab (it draws `TrinaList`) |

## Scope

In:

1. **Sections in the Trina list** (`TrinaList.tsx`): between 고정 (pinned) and 트리나 기록, my sections of kind `chats` in
   their order, each a `PanelSection` (name, ▾ fold, count, "⋯": Rename · Move up · Move down · Delete section, as
   `SectionMenu`). A chat in a section is not repeated in 트리나 기록 (one place per chat, as Chats: pinned › section ›
   history). Empty section: one line and how to fill it ("Drag a chat here, or use Move to section in its ⋯"). Data
   from `GET /api/chats/groups` `folders` (count, first rows) and `GET /api/chats?folderId=` for "더 보기" in a
   section, as the 11-13 Trina folders did.
2. **Fill**: Move to section / Remove from section in the chat row's "⋯" (desktop), the phone long-press sheet and the
   chat header "⋯"; drag a row onto a section header, between sections, and onto 트리나 기록 to take it out. A toast
   says where it went, with Undo (`undoMoves` made kind-generic).
3. **One code path**: `SidebarSections.tsx` gets a `kind` (`'rooms' | 'chats'`): `useSections(kind)`,
   `useSectionActions(kind)`, `useSectionRowItems(kind, …)`, `SectionMenu`, `SectionEmpty`, the name check. The Chats
   sidebar calls them with `'rooms'` (behaviour unchanged); the Trina list with `'chats'`. `NavFolders.tsx`'s generic
   `useFolderActions`/`NewFolderRow` stay the base; no second sections system. Strings are the `sidebarSections.*`
   keys; only the few that name "conversations" get a chats variant.
4. **The menu** (`RecentsMenu`, desktop dropdown and phone sheets), rows in this order:
   Status ▸ · Last activity ▸ | Group by ▸ · Sort by ▸ | **New section** | **Reset to defaults** (only when changed).
   Same keyboard as today. The filtered list (`HistoryList`) shows sections too only while Group by is None or Date
   (with Group by Project the project groups stand alone, as now); a filter applies inside sections.
5. **Foldable date groups** in `HistoryList` (Today, Yesterday, This week, This month, Older): the header is a fold
   button as `PanelSection`'s, key `section:trina-date:<bucket>`.
6. **Per person on every device**: `UserPrefs.historyView` = `{ panel?: Partial<RecentsView>, drawer?: Partial<RecentsView> }`
   (only what differs from the default, so a later default still reaches people, as the localStorage key does now).
   Read from `me.prefs`, written with `PATCH /api/me` (debounced, optimistic). The localStorage value is moved once
   into prefs when prefs has none, then the key is removed. No migration (prefs is one JSON column).
7. **Server rule for project chats**: today a chat in a project (or a shared chat) cannot go in a list folder
   (`nav-folders.ts` 216 and the `c.project_id IS NULL` read filter), and moving a chat into a project takes it out.
   Keep that rule (see open question 1): the row's Move to section is shown off with its reason, as the 11-13 menu did.

Out (cuts to stay lean):

- **Group by Status**: Status is already a filter ("Answering or waiting for you"); a group per state would show a
  near-empty header most of the time and the waiting row on top already gathers what needs me.
- **Environment**: Trina has no per-chat environment.
- **View all**: our grouped view's caps already end in "Show all projects"/"N more"; a second "View all" would be a
  duplicate.
- **"Show" as a new menu name**: our Status and Last activity already are Claude Code's Show; renaming them would
  break settled names (naming-decisions).
- Emoji on sections, sort inside a section, sections shared with the team, sections that mix chats and rooms (one
  kind per list, as the server's composite key already enforces).
- A section's "+ Ask Trina here" (the 11-13 folder header had it): not in Claude Code's menu; later if asked.

## Steps

1. This plan (first commit). Then wait for the plan review and fold its changes in.
2. `SidebarSections.tsx` kind-generic; Chats sidebar unchanged (its unit and e2e tests must stay green).
3. `TrinaList.tsx`: sections block from `groups.folders`, one place per chat, fold, empty line, "더 보기".
4. `ChatItem.tsx` row "⋯" / phone sheet / chat header: Move to section, Remove from section, drag source.
5. `HistoryList.tsx`: menu rows New section and Reset to defaults; date headers fold; sections in the filtered list
   (None/Date grouping).
6. `UserPrefs.historyView` in shared, server accepts it in `PATCH /api/me` (zod), `useRecentsView` reads/writes it;
   one-time move from localStorage.
7. i18n: new keys in `en.ts`, then ko, ja, zh, es, id.
8. `changes/history-sections.md`; decision `docs/decisions/20261122-trina-history-sections.md` (it brings back the
   kind `chats` folders the owner took off the screen on 11-13, now as sections, at the owner's request of 11-22).
9. Screenshots (1440 and 390, light and dark: the menu, sections with chats, an empty section, folded date groups)
   in `shots-histsections/`, checked by me; ui-polish pass.
10. Tests, QA sheet rows, PR into dev (no enqueue).

## Decisions

- New: `docs/decisions/20261122-trina-history-sections.md`.
- Changes: DECISIONS.md "List folders on screen" (2026-11-13; the Trina folders went off the screen that day:
  TrinaList.tsx header) and keeps docs/decisions/20261121-personal-sidebar-sections.md's model and name.
- Keeps: "Trina history: Group by defaults to None" (11-14), and the flat 트리나 기록 under the sections.

## Open questions, each with a recommendation

1. **Project chats in a section?** Claude Code puts any session in a section. Our server refuses project and shared
   chats (a project chat lives in its project). *Recommendation: keep the rule for this PR* (no server change, no
   permission review; the row says why), and reopen it if the owner tries to file a project chat. Changing it later is
   a small server change (the items are already per person).
2. **Sections in the filtered list?** *Recommendation: yes for Group by None and Date (sections on top, filtered),
   no for Group by Project* (two kinds of headers would compete).
3. **Default fold of a new section?** *Recommendation: open*, as Chats sections.
4. **Phone drag?** *Recommendation: none* (a long press is the row's sheet); Move to section is the phone's way, as in
   Chats.
5. **Where "New section" lives on desktop**: Claude Code puts it in the sidebar menu. *Recommendation: only in the
   history menu and in Move to section* (no "+" on the 트리나 기록 header: one more button at rest).

## Risks

- Migration: none (prefs JSON, existing nav_folders tables). Highest on dev: 702.
- `PATCH /api/me` body grows: the security route coverage and the prefs size cap; `historyView` is bounded by the
  enum values.
- The Chats sections must not change: the kind-generic refactor is the risky part; their unit and e2e specs run.
- Five app languages (+ en): `check:i18n`.
- Phone and desktop: the 트리나 tab and the ☰ drawer.
- Mock server (`web/test/mock/server.ts`): `/api/nav-folders` for kind chats, `/api/chats/groups` folders,
  `/api/chats?folderId=`.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`; web unit: `sidebar-sections.test.tsx`,
`nav-folders.test.tsx`, new `history-sections.test.tsx` (one place per chat, fold keys, menu rows, reset, prefs
read/write and the localStorage move); server: `tests/unit/b-nav-folders.test.ts`, the `/api/me` prefs test; web e2e:
`sidebar-sections.spec.ts` (unchanged), new `history-sections.spec.ts` (make a section from the menu, move a chat by
the menu and by drag, fold, phone sheet), `type-scale.spec.ts` and `session-markers.spec.ts` (history rows).

## Result

Filled in at the end.
