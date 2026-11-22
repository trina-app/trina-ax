# Create a channel as a project: one tick in "Create a channel"

- Date (UTC): 2026-11-21 23:10
- Branch: `feat/create-channel-as-project`
- Status: built; screenshots to the owner before the PR
- Where: web (the people picker's channel mode, i18n, e2e). Why: the dialog is `web/src/components/rooms/PeoplePicker.tsx`;
  the project is made by the existing `POST /api/projects` and its room opened by `POST /api/projects/:id/room?listed=1`,
  so no server change.
- Version impact: minor. A new option in an existing dialog (a new way to make a team project); no API change.

## Goal

The owner (2026-11-22): in "Create a channel" (채널 만들기), a tick so that the people picked get a shared project at
once, instead of "create a channel, then ⋯ › Make it a project". Agreed with session 4f (owner of project rooms): never
make a channel and convert it; reuse the "New project with" path (make the team project with the picked people, then
open its room with `?listed=1`).

## Scope

In:
- `PeoplePicker.tsx` (channel mode): one row under the channel name, a checkbox "Make it a project" with the muted line
  "Shared folder and Trina for these people". Off by default; shown only to someone who may make team projects
  (`mayMakeTeamProject`) and not in a free-roam demo.
- When ticked:
  - the primary button reads "Create project";
  - the name follows the project rules: empty, reserved (`projectNameProblem`), and the taken-name hint with the "-2"
    folder (`rooms.makeProject.nameTaken`), from the team projects the person sees (as `NewProjectDialog` does: a clash
    with a project they cannot see stays unsaid, as the server's make-project read keeps it);
  - guests follow project rules: a guest who holds another project is greyed out with where they are ("In the X
    project", Make team member for admins); a guest whose project slot is free can be picked (a private channel never
    takes a guest);
  - Create makes `POST /api/projects` (scope team, the picked people as participants), then opens its room listed
    (`openProjectRoom(id, true)`) and goes there; if the room fails, the project page (never a second project).
- i18n: two new keys (`rooms.picker.asProject`, `rooms.picker.asProjectHint`) and `rooms.picker.createProject`, in all
  6 languages, en first.
- Tests: web unit test for the folder-name step; e2e at 1440 and 390 (off makes a channel; on makes a project and lands
  in its listed room with the same people; a taken name shows the hint; a guest is blocked as the rules say).
- changes/ note, decision file.

Out:
- A server name-check endpoint for a project that has no room yet (the client check is the one New project uses).
- Groups picked in the dialog become their people (a snapshot), as for a channel; not the group as a participant.

## Steps

1. Plan (this file).
2. PeoplePicker channel mode: the row, the project rules, the create path.
3. i18n in 6 languages.
4. Unit test, e2e, screenshots from a local mock (off, on, name taken; 1440 and 390; light and dark).
5. changes/ note and decision file; typecheck, check:prepush, unit, e2e, tests/security for project creation.

## Decisions

- No channel is made and converted (4f): the project and its room are made the way "New project with" makes them.
- Name check on the client from the visible team projects, like New project: no new endpoint for a hint.

## Risks

- A project the person cannot see may still step the folder to "-2" without a hint (same as today's New project and
  the make-project read).
