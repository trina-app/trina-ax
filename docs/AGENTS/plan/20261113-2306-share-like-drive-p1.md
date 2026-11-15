# Share like Google Drive (P1): one Share dialog, Drive's words and order

- Date (UTC): 2026-11-13 23:06
- Branch: `feat/share-like-drive-p1`
- Status: done
- Where: Team AX core (`web/`). Why: files and permissions are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, the folder sharing dialog and its words change; no data, API or migration change

## Goal

The owner wants folder sharing to look the same as Google Drive's Share dialog. Today there are two editors with two
vocabularies: Files › ⋯ › "Who can open it" and Admin › Folder permissions › "Change rules" (Basic access, No access).
P1 makes one dialog, used from both places, with Drive's words and order. Who can open what does not change: the
permission function (deepest rule wins) stays until P2, and the dialog says truthfully where a role here is lower
than what someone would get otherwise.

## Scope

In:
- Files › folder ⋯ › **Share** opens `Share "<name>"`: the add field ("Add people and groups"), **People with access**
  (rows with a role menu Viewer / Editor / Remove access, no ✕; greyed rows from folders above; a fixed "Owner and
  admins · Full access" row, not in project folders or personal folders), **Access removed** for existing "No access"
  rows (Drive's **Add** brings someone back), **General access** as Restricted / {team} + Viewer / Editor with the
  inherited value shown ("From …"), no "Same as …" choice.
- Downgrade captions wherever a row's role is lower than what the person would get otherwise (a group above, the team
  above, General access Editor on the same folder, their group on the same folder), and a lasting caption when General
  access here is lower than the parent's.
- Admin › Folder permissions: [Change rules] / [Set rules] becomes **[Share]** and opens the same dialog (a dialog on
  computers, the bottom sheet on phones). `AccessEdit.tsx` and its `&rules=` phone page are removed; `?edit=<path>`
  still opens the dialog. The folder part's "This folder's rules" chips go (the dialog shows the rows).
- File ⋯ "Share (copy)" becomes **Copy to…**.
- Words: en first, then ko with Google Drive's own Korean terms, id, ja, es.

Out (P2, separate PR): additive inheritance, a `limited` flag, refusing "No access", the conversion.
Deliberate differences from Drive: no Commenter, no "Notify people", no "Copy link", only the owner and admins share.

## Steps

1. `lib/folder-sharing.ts`: general access as audience + role, `pickBasic`, downgrade reasons (pure, unit tested).
2. `FolderSharing.tsx` and `FolderAccess.tsx`: the new layout; an admin mode for Admin (root, any rule row, no
   "Open in Folder permissions").
3. `AccessTree.tsx`: [Share] opens `FolderAccessPanel`; remove `AccessEdit.tsx`, its outcome helpers and keys.
4. `Files.tsx`: "Share", "Copy to…".
5. i18n (5 languages), user docs, PERMISSIONS.md, DECISIONS entry, `changes/share-like-drive-p1.md`.
6. Tests: web unit, e2e (`folder-access.spec.ts`, Admin specs that opened the old editor), screenshots at 1440 and
   390, light and dark, on a copy of the QA team.

## Risks

- Removing Admin's editor: everything it did must still be possible in the dialog (root, rule rows outside the tree,
  Add folder, By person's `?edit=`), except creating new "No access" rows, which P1 stops offering (as the spec says).
- Showing Drive's words over deepest-wins: the captions above must stay until P2.
- No server change: `tests/security/folder-sharing.test.ts` stays as it is.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit (`folder-sharing*.test.ts*`,
`folder-access.test.ts`), targeted e2e (`folder-access`, `access-tree`, `access-people`, `admin-delete`,
`phone-admin-pages`, `a11y`, `team-skills`, `admin`).

## Result

Built as planned. Differences: a group row's caption also names a member whose own row above lets them edit; in Admin a
team project's folder opened by its address shows the server's refusal in the dialog; Admin's live "who can edit
skills" line in the old editor is now the one line Drive-style ("Editors can change the team's skills"). PR: see the
branch's pull request to dev.
