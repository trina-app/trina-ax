# A Share button in the project's title row, and people in New project

- Date (UTC): 2026-11-15 15:49
- Branch: `feat/project-share-button`
- Status: draft
- QA: TC-3283
- Where: Team AX core, web only (`web/src/pages/Projects.tsx`, `web/src/components/NewProjectDialog.tsx`,
  `web/src/components/ProjectParticipants.tsx`, `web/src/components/chat/ChatProject.tsx`, `web/src/i18n/*`, tests,
  `docs/site/use/chats-and-projects.md`, `docs/DECISIONS.md`). Why: projects and sharing are core
  (docs/REPOSITORY-RULES.md); the server already has every path this needs.
- Version impact: **minor**. A visible change of where a project is shared and a new optional field when making one.
  No API, data or setting change.

## Goal

A user could not find how to share a project. Today the project page says "Members · Only me · Add people" in small
type at the bottom of the side column (on a phone it is the last line of the page), and New project asks only a name.

The owner's direction (2026-11-15), designed here, not reopened:

1. A **Share** button in the project's title row, top right, as Notion, Google Drive and Claude projects have it. Next
   to it, who can see the project: "Only me", or small faces.
2. An optional **People** field in **New project**, through the same server path and checks as adding people later.
3. The bottom "Members" line goes: one place to manage people.
4. Who may share does not change.

Non-developer check: "Weekly reports · Only me · [Share]" at the top of the page. A colleague who wants to add someone
sees it in 3 seconds, as in Drive.

## What there is today (read from the code)

- **Two dialogs, one per kind of project.**
  - A personal project (`users/<me>/projects/<name>`): **Add people** opens `ShareProjectDialog` (Projects.tsx). It
    calls `POST /api/projects/:id/share`, which moves the folder to a new `projects/<name>` with the members' rules.
  - A team project (`projects/<name>`): **관리 / Manage** opens `ProjectMembersDialog`
    (`GET access`, `POST access-preview`, `PUT participants`). PR #976 is reworking this dialog (one press, an inline
    warning). #976 holds only its plan today, so this PR builds on dev's dialog and only opens it.
- **The faces** of a team project are already a line under the name (`PeopleStack`); they open the members dialog
  (read-only for a member who cannot change them: the list of people and who changes them).
- **The bottom line** is `MembersRow` for a team project (who sees it and Manage, or a hint who changes members, or an
  admin's note on a project made outside `projects/`, with a link to Admin › Folder permissions), and for a personal
  project "Only me · Add people", or "Only me" with "In this team only the owner and admins share projects with
  others."
- **Who may share** (unchanged):
  - personal project: its creator, and only when they may make team projects: the owner and admins always, members
    unless Team settings says admins only (`me.team.projectCreators`; server `assertMayCreateTeamProject`).
  - team project: `Project.membersEditable` from the server: its creator, the owner or an admin (also one who is not a
    member), on a `projects/<name>` folder the server made.
  - nobody in a project in the trash; a guest never.
- **Making a team project with people** already exists on the server: `POST /api/projects` with `scope: 'team'` and
  `participants` runs `assertMayCreateTeamProject`, `checkParticipants`, `newProjectRules`, `validateRules` and
  `makeProjectFolder`, and marks the project's chats shared: the same calls as `shareProject` (minus the folder move,
  since a new project has no files). Its dry run for the count is `POST /api/projects/access-preview` without a
  `projectId`. The web stopped using it on 2026-11-13 ("a name, only me, people later").

## Design

### The title row (computer)

`[ Project name ...................... (faces | Only me)  [Share] ]`

- One flex row: the `h1` on the left (wraps, `min-w-0`), a cluster on the right on its first line.
- **Who sees it** (left of the button), by the rule of today's line (`whoSeesProject`):
  - a personal project, or a team project where I am the only person: "Only me" in muted text.
  - a team project with two or more people: the faces (`PeopleStack`, 24 px, 4 and "+N"), and "Includes 1 guest" when
    there is one.
  - a project made before outside `projects/` (no people list): its words ("3 people", "Only me and admins").
  - in the trash: nothing (as today).
  The faces and the words of a team project are one button that opens the members dialog, read-only for whoever cannot
  change it (as the faces do today). "Only me" of a personal project is plain text.
- **Share**: the app's `Button` (`size="sm"`, secondary, a people icon and the word "Share"). It opens
  `ShareProjectDialog` for a personal project and `ProjectMembersDialog` for a team project. No logic of its own: what
  #976 changes in the members dialog comes along.
- **Can't share → the button is hidden**, not read-only. A Share that opens a dialog where nothing can be shared is a
  dead end; the faces next to it already open the read-only list, which says who changes the members. On a personal
  project in a team where only admins share, "Only me" gets the existing line "In this team only the owner and admins
  share projects with others." as its tooltip (focusable, so it is read out too).

### Phone (390 px)

The phone hides the `h1` (the name is in the top bar). The same cluster is one row under the bar: who sees it on the
left, **Share** on the right (44 px tall). Not an icon in the bar and not in the ··· menu: the problem is that people do
not find sharing, and a labelled button in the page finds itself; the bar already holds ‹ and ···. A project with
nothing to show there (in the trash) has no row.

### Removed

- The side column's **Members** line: `MembersRow` for a team project and "Only me · Add people" for a personal one.
- The separate faces line under the name (the faces move into the title row).
- What they said moves:
  - "Members are changed by Sam (creator) or admins": already in the members dialog for whoever cannot change them.
  - the admin's note on a project made outside `projects/`: already in the dialog; its link to Admin › Folder
    permissions moves into the dialog's note (one line, kept so the admin still has the way there).
  - "In this team only the owner and admins share…": the tooltip above.
- The owner or an admin who is not a member had a side column with only the Members line: it has no side column now.
- Kept: the list card's ⋯ **Members** (a shortcut on the list to the same dialog, not a second place) and the "who sees
  the chat you're starting" chip under the box (it opens the same dialog).

### New project: People (optional)

- Under the name: **People (optional)**, the picker of the share dialog (me fixed as "You", search to add people and
  groups). One shared component, `ProjectPeopleField`, used by `ShareProjectDialog` and `NewProjectDialog`, so both say
  the same thing the same way.
- No one picked: as today, "Only you see it. You can add people later." and **Create** makes a personal project.
- People picked: the count line ("3 members", the server's dry run, 400 ms after the last pick) and the share note
  ("Everyone you add can see and edit its files and instructions, and the chats started here from now on. This can't
  go back to only you."). **Create** makes a team project: `POST /api/projects {scope: 'team', participants}`, the same
  server checks as sharing later. No second confirm: as in the share dialog, the button is the yes (#976's one press).
- Shown only to someone who may share (as above). A member whose team lets only admins share, and a guest, see the
  name only and "Only you see it.".
- Not in **Move to project › New project** from a chat: that flow's Undo deletes the project only while it is still
  "Only me", and a moved chat arrives private anyway; the field there would add a step to a one-field shortcut.

## Steps

1. Plan (this commit), draft PR to dev, one independent plan review.
2. `ProjectPeopleField` in `ProjectParticipants.tsx`; `ShareProjectDialog` uses it.
3. `NewProjectDialog`: the field (prop `people`, off from `ChatProject`), scope by picks.
4. Project page: the title row (`ProjectTitleRow` in Projects.tsx), the phone row, remove the Members line and the
   faces line; the admin link in the members dialog's legacy note.
5. Strings: English first, then ko, id, ja, es, zh. Remove the strings nobody uses any more.
6. Tests, docs (`chats-and-projects.md`, DECISIONS entry that amends "Making a project: a name, only me, people later" and
   "Project members in one panel"), changelog fragment `changes/project-share-button.md`.

## Risks

- Shared page: many e2e specs read `project-members`, `project-share`, `project-people-header`. They move to the new
  test ids; the full web e2e runs.
- #976 edits `ProjectMembersDialog` too. This PR touches only its legacy note line there, to keep the conflict small.
- A wrong "may share" check in the web would only show or hide a button: the server refuses as before.
- No migration, no server change.

## Tests

- Web unit: the title row (who sees it and Share for: personal I may share, personal admins-only, team I manage, team
  member read-only, outside admin, in trash, guest), `NewProjectDialog` (no picks → personal, picks → team with
  participants, field hidden for admins-only and from Move to project), `ShareProjectDialog` still shares.
- E2E: `project-share-button.spec.ts`: Share on a personal project shares it; Share on a team project opens the members
  dialog; a member sees faces but no Share; New project with a teammate makes a team project they see; at 1440 and
  390, light and dark, with screenshots. Update the specs that used the old line.
- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the full
  web e2e.

## Result

Filled in at the end.
