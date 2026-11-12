# Projects from before the update: one card for the owner and admins, "Add me to these" (QA TC-360)

- Date (UTC): 2026-11-12 13:00
- Branch: `fix/old-projects-notice`
- Status: in progress
- Where: trina-ax core (`server/src/chat/old-projects.ts`, `chat/project-joins.ts`, `chat/schedules.ts`,
  `routes/chats.ts`, `notifications/service.ts`, `shared/src/api`, Admin › Home and the phone's Admin list). Why: project
  access, scheduled tasks and the admin screens are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch (a card, three routes and a notice field; nobody can read anything they could not read on 0.4.0)

## Goal

After 0.4.0 → 0.5.0 the owner and admins lose team projects they read by their role on 0.4.0 ("Project contents only
for members"), and nothing tells them. The owner chose (2026-11-12, "안내 + 한 번에 추가"): ONE card for the owner or
an admin, "N projects from before the update are for their members only now", listing them, one button "Add me to
these" (a member of all of them at once, audited, their members told) and a dismiss. Members see nothing. Their
scheduled tasks on such a project pause with a plain message and start again once they are added back.

## Which projects (what 0.4.0 showed)

0.4.0 gave the owner and admins write on every path outside `users/` by role (`RuleSet.decide`), so every team project
in `projects/<name>` was theirs to read. The update's first start is the `projectsMembersOnly.v1` setting (its time,
T). The card lists, for a person who is the owner or an admin now, had an account before T and whose role was not
changed since T (`user.update` with a role, `owner.transfer`):

- team projects in `projects/<name>` (any letter case, as the zone) made before T, folder in place (not in the trash),
- that the person does not read now (`canSeeProject`) and may manage (`mayManageProject`),
- and that the person did not join and leave since T (`project.member_gained` for them, or a members save after T that
  took a rule naming them out).

Nothing is stored but the dismissal (`suggestion_dismissals`, key `members_only_update`): the list is worked out each
time, so a project they joined, one deleted or trashed, drops out by itself. A folder adopted as a project after T
(`Projects/` leftovers) is not on it (made after T): unchanged behaviour.

## Add me to these

`POST /api/projects/update-notice/join`: for each listed project, the members as they are and the person, saved as the
members dialog saves them (`saveParticipants`: rules hash, `folder.rules` audit with `self`, `project.member_gained`,
its members told). A project that cannot be saved is skipped and counted. One more audit row
`projects.update_joined` (projects joined, skipped). Then the card is dismissed. Only projects on the list, so nobody
gets more than the 0.4.0 role gave them (and the owner and admins can already Add me on each project).

## Scheduled tasks

Paused already (`schedule_project_skips`, #? "Projects made on 0.4.0"). Now: the inbox notice for a task whose project
is live and the person may manage says "paused: only its members can use it now; add yourself in Projects and it
starts again" (`membersOnly: true`), and when the person starts to read the project (`projectJoins`), a task of theirs
that this pause turned off, untouched since, is turned on again (`schedule.resumed`, actor null, `via: project_member`).

## Tests

`tests/unit/b-old-projects-notice.test.ts` (0.4.0-shaped data: card per person, members see nothing, Add me to these,
the audit, nobody gains more, the task resumes), web unit test of the card, e2e on Admin › Home.
