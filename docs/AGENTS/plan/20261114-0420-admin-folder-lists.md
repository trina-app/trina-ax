# Admin › Folder permissions as two lists, like Drive (with P2)

- Date (UTC): 2026-11-14 04:20
- Branch: `feat/admin-folder-lists`
- Status: done
- Where: Team AX core (`web/src/pages/admin/`). Why: files and permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, Admin › Folder permissions changes; no data, API or access change

## Goal

The owner found the rule tree and rule words "too unfamiliar and hard": sharing should feel like Google Drive shared
drives. Drive has no admin table of rules; its admins change a folder in its own Share dialog. With P2 (#787, access adds
up, Limit access is a folder's `limited` flag) and its Share dialog (owned by #787), Admin › Folder permissions becomes
two plain lists.

## Scope

In:
- **Folders shared differently**: only folders with their own sharing, in the Files page's names (Company-wide › …),
  **Limited** marked (`Folder.limited`), who in one line, [Share] opening the Share dialog; project folders as one line;
  a group's own folder as it was made is not listed; rule rows on folders Files does not show stay reachable by path.
- **What <person> can open**: read only; each folder with Viewer / Editor and why (the server's reason, incl. `cutAt`
  and `left`); Can't open, with other groups' folders as one count line; the owner and admins one line.
- Remove the rule tree, the By person matrix, "Only folders with rules", "How this works", "Add folder", rule words, raw
  folder names, the stale strings (`rules.keepTeam`, `rules.removeBody`, the tree's badges), the group head-count
  mismatch. Admin and person-page cuts of the second plan review. Empty states from that review.
- Phone 390: the same lists; a person is a page of their own; one Back from a Share sheet returns to the list.
- Words: en first, ko, id, ja, es. Docs page section and its two screenshots.

Out: the Share dialog itself, Limit access, Access removed, the group warning and the Admin notice (#787).

## Steps

1. `Folders.tsx` (two tabs, `?edit=` opens the Share dialog, `?folder=` from old links too), `FolderLists.tsx`.
2. Remove `AccessTree.tsx`, `AccessPeople.tsx`, `AccessResults.tsx`, `FolderPeople.tsx`; Members' invite preview moves.
3. i18n, docs, DECISIONS, `changes/admin-folder-lists.md`.
4. After #787 is on dev: rebase, finish against `Folder.limited` and the reasons, tests, e2e, shots, review.

## Risks

Removing the tree: every folder with rules must stay reachable (the list shows every rule row). Phone history: the
Share sheet and `?edit=` must not take two Back presses (or skip the list).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run features:check`, web unit, e2e
`admin-folders` (new), `access-people`, `admin-delete`, `phone-admin*`, `a11y`, `team-skills`, `admin`, the feature-map
shards that run them.

## Result

Built as planned on top of #787 (merged as 727dcfcf). Differences: the Share dialog, Limit access, Access removed, the
group warning and the conversion notice are #787's (the notice is shown on the Folders tab); a team project's folder
opened here shows the project's lines (from the manage=1 project list), never its rules. An independent (opus) review
asked for limited folders with nobody added and limited group folders to be listed, the container folders and other
projects' folders out of "Can't open" (projects as one count line), "Limited" with its own word in ko/id, and dead words
removed; all done (DECISIONS). Tests: web unit, e2e admin-folders (new), access-people, admin-delete, admin, team-skills,
a11y, phone-admin*, phone-back-parent, phone-list-pages, phone-menus-tabs, people-console, and the four feature-map
shards locally. The PR: see the branch's pull request to dev.
