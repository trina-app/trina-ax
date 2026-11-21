# Trashed projects leave the Projects list; one quiet Trash row at its bottom

- Date (UTC): 2026-11-21 04:38
- Branch: `fix/projects-trash-out-of-list`
- Status: in progress
- Where: trina-ax core, `web/` (the Projects panel, the phone's Projects tab, the Projects page). Why: the project list
  and its trash are core UI (docs/REPOSITORY-RULES.md).
- Version impact: patch. A list shows fewer rows and gets a Trash row; no API, permission or data change.

## Goal

The owner on qa (2026-11-21), on "Team projects" full of rows with a trash icon and "in the trash": "지운 게 저렇게
보여야해?" A trashed project should not clutter the list, as in Drive and Notion.

## Scope

In:
- A project in the trash is not a row of any group (Team projects, My projects, Other team projects) in the Projects
  panel, the phone's Projects tab, or a card on the Projects page.
- At the bottom of the Projects list, one quiet "Trash" row with a count. It shows only when the person can restore at
  least one trashed project (`Project.canRestore`: the owner and admins, a creator who is a member). It opens a dialog
  (a bottom sheet on a phone) listing the trashed projects the list already gives them (`GET /api/projects?manage=1`:
  `inTrash` with `trashed`, and `wasMember` or `canRestore`): name (a link to its page), who moved it there and when
  (`useTrashLines`, the note's words), and Restore where `canRestore` (the existing `trashProject(p, false, …)`).
- A direct link to a trashed project still opens today's in-the-trash page (`ProjectTrashNote`).

Out: no server change; Files › Trash keeps its project rows; Delete for good stays on the project's page and in Files ›
Trash.

## Steps

1. `ProjectsList`: drop `inTrash` from every group; compute the trash list from the managed list; add `ProjectsTrashRow`
   and its dialog.
2. Projects page: no card for a trashed project.
3. i18n in en, ko, ja, zh, es, id.
4. Unit test of the pure filters; e2e (projects-panel.spec.ts): hidden rows, the Trash row per role (owner, admin,
   member, member who made it), restore from the dialog, at 1440 and 390.
5. Decision file, changes/ note, screenshots before and after (local mock).

## Decisions

`docs/decisions/20261121-projects-trash-out-of-list.md`. Amends "A team project in the trash: its members keep its card"
(docs/DECISIONS.md, 2026-11-13): the card no longer stays in the list; the Trash row holds it.

## Risks

Permissions: the dialog lists only what `manage=1` already gives the person (no new reads); nobody sees a trashed
project they could not see before. A member who can restore none sees no row (their direct link still works).

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run --cwd web test`, `tests/security/project-trash-state.test.ts`,
web e2e projects-panel and the related project specs.

## Result

(at the end)
