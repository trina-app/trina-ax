# Trina history grouped by project, like the Claude Code desktop sidebar (TC-424)

- Date (UTC): 2026-11-12 16:21
- Branch: `feat/history-by-project`
- Status: done (layout of the sidebar still open with the owner)
- Where: Team AX core (`web/src/components/`, `web/src/lib/`). Why: the AI history is core chat UI (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch, a web-only change of how the history list is shown; no API, no migration

## Goal

The owner (2026-11-12) showed the Claude Code desktop app's sidebar: "세션들이 유지되어야". Each piece of work should keep
its chats together so a person goes back to it there. Today Trina history is the five latest chats in one flat list;
the project of a chat shows only three clicks deep ("Show all" › Group by › Project).

## Scope

In:
- Trina history grouped by **project**: a small grey header per project (its name, a folder icon, ▾ that folds the
  group), the project's chats under it newest first. Groups follow the newest activity in them. Chats in no project (or
  in a project the person can no longer see) form the last group, "Other chats".
- A person with no project chats sees no headers: the list as today.
- One self-contained list component with the caps as parameters (projects shown, rows per group), so it works stacked
  under the rooms (a computer: at most 5 projects plus the other group, 3 rows each, "N more" opens a group in place)
  and as a whole panel (the phone's drawer, "Show all": every project, every row). The sidebar's layout itself may still
  change (the owner is asked how to split rooms and history); this branch does not change the rooms section, the menu
  rows or the sidebar's layout.
- A folded group keeps a status mark on its header ("?", ring, dot) when a chat inside has one; "N more" carries the mark
  of the rows it hides. Folding is remembered per person in this browser.
- + on a project's header (on hover and focus; always on touch) opens the project page with its "New chat in this
  project" box focused. The project's name opens the project page.
- "Show all": "Group by: Project" becomes the default; Date stays one choice away.
- Pins stay as they are, above the groups. Rows, marks, peek, menus unchanged; "Move to project…" moves the row to its
  group at once.
- A DECISIONS entry that supersedes the flat five ("Desktop sidebar: rooms first") and "the list is not re-sorted by
  state" ("Session markers"); a `changes/` note. All 5 languages, English first.

Out: a sort button (groups follow the newest activity), a new layout of the sidebar (waits for the owner), ⌘K and
Files (another branch), any server change.

## Steps

1. `web/src/lib/historyGroups.ts`: pure grouping (by visible project, newest first, the other group last), the caps,
   the chat on screen, a group's strongest mark. Unit tests.
2. `web/src/components/history/`: the list component, its header, the projects the person can see (one read of the
   project list, again on focus and when a chat names an unknown project), the folded groups per person.
3. Use it in the sidebar's Trina history and the phone's drawer; "Group by: Project" as the default (an old remembered
   view keeps its filters but not its old default grouping).
4. The project page focuses its box when opened from +.
5. i18n, DECISIONS, changes, unit tests, e2e specs that assumed the flat five, screenshots, review.

## Risks

- Access: a project's name shows only if the project list says the person can see it now (and the chat header did not
  find it gone); otherwise its chats are in "Other chats", the same as the chat page, which shows no project then.
- The sidebar gets taller with headers; the caps keep it bounded where rooms share the column.
- Remembered views: everyone who once touched the filter has `group: "date"` stored (the old default); that value is
  dropped once so the new default applies.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; web unit tests for the sidebar, history groups, pins,
projects and session markers; `bun run test:web`, `bun run build:web`; e2e specs for the sidebar, history, Show all,
pins, projects and the phone drawer.

## Result

- Built as planned: `lib/historyGroups.ts` (grouping, caps, the strongest mark), `components/history/HistoryGroups.tsx`
  (the list, its headers, folds per person, + per project), used in the sidebar's Trina history and the phone's drawer;
  "Group by: Project" is the default of "Show all"; the project page focuses its box when opened from +.
- Differs from the plan: the projects the person sees are kept in `store/projects.ts` (`listed`), one read for every
  sidebar of the window (the review found each drawer opening read the list again and blanked the history); a slow
  first read shows the plain list after 1.5 s; the "In a project" filters follow the same access rule; after a move the
  keyboard goes to the moved row's "···" (the row is a new one in its group).
- Hands-on on the local QA team (qa-member, qa-member4, qa-member2 for the access check) and screenshots at 1440 light
  and dark and 390 light. The owner is deciding how the sidebar splits rooms and the AI history ("이미 대화방만해도 너무
  길어"); the caps (5 projects, 3 rows) are two constants in `Sidebar.tsx`.
