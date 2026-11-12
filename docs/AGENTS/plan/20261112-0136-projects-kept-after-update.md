# Projects made on 0.4.0: what the owner and admins keep after the update (QA TC-360)

- Date (UTC): 2026-11-12 01:36
- Branch: `fix/projects-kept-after-update`
- Status: done
- Where: trina-ax core (`server/src/chat/schedules.ts`, tests). Why: scheduled tasks and project access are core
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch (a scheduled task that could not work any more is paused and its owner told; no API, data or
  permission change)

## Goal

QA updated a real 0.4.0 team (an admin made two team projects, the owner had a chat and a scheduled task on one of
them) to 0.5.0 and found: the owner and another admin no longer open those projects, but the owner's chat there is
still listed and readable and the owner's scheduled task on the project's folder stays on and keeps running.

What was decided (docs/DECISIONS.md "Project contents only for members", owner option B, 2026-11-10): a team
project's contents are its members' only; the owner and admins keep the project in their Projects list
(`GET /api/projects?manage=1`, `member: false`, "Only members can see what's inside", #474), manage its members and add
themselves (which its members are told). The start steps (`chat/members-only-once.ts`) take away what they kept by
role, and the decision says "No notice at the upgrade, only the changelog". So the 404s and the empty
`GET /api/projects` (no `manage`, "projects I read", which is what the QA probe asked) are the rule, not the bug.

What does not follow the rule:

- A **template** scheduled task (Daily file index, Weekly summary) whose source folder is in a project its owner no
  longer reads. `members-only-once` step 3 only looked at save folders, and the run checks only `project_id`, so such a
  task stays on, starts every day, and its turn fails at dispatch (`validateTemplateTurn` refuses the folder): a new
  failed chat each day, nothing that says why. A task with a project (`project_id`) is skipped, paused and its owner
  told once (`schedule_project_skips`, docs/DECISIONS.md "Project skills"); a template task on a project's folder
  should do the same.
- The owner's own chat in such a project stays theirs (H7 "권한 회수": a person's own conversation is never taken away;
  the project's name, folder and instructions stop reaching the AI, `projectForChat`). That is consistent and stays;
  this change adds the test that pins it (readable, a new turn gets no project).

## Scope

In:
- `chat/schedules.ts`: a template task whose source folder is in a project (`projects/<name>/…`) its owner does not
  read now is treated like a task whose project is gone: at a due run it is skipped, paused and its owner told once
  (`schedule_project_skips` with that project's id, the existing "project gone" notice and words); "Run now" refuses
  with the same reason.
- Tests: an upgrade test that builds a 0.4.0-shaped team (an admin-made `projects/<name>` with the 0.4.0 folder rules:
  participants and creator write, no project notices, the start steps not yet run) and then runs the start steps and
  checks the owner, another admin, the creator and a member: projects list with and without `manage`, the folder,
  "add me"; the owner's own chat (readable, no project for a turn); the owner's template task (skipped, paused, told
  once, "Run now" refused) and a template task on a folder they still read (runs).
- Changelog fragment `changes/projects-kept-after-update.md`.

Out (open questions for the owner, in the PR):
- A one-time notice to the owner and admins at the upgrade ("N team projects are now members only"). The decision's
  default 4 says no notice; the QA row expected one. Not changed here.
- A folder in a `Projects/` (any letter case) that was an ordinary team folder on 0.4.0 becomes members-only: the
  owner and admins lose it while members keep it, until an admin opens Projects and it is adopted as a project. As
  decided; noted for the owner.

## Steps

1. Plan (this file), first commit.
2. `templateProjectGone()` in `chat/schedules.ts`; use it in `runDue` and `runNow`.
3. Tests: `tests/unit/b-projects-after-update.test.ts`.
4. Changelog fragment, DECISIONS entry.
5. `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the schedule and project unit and security suites.

## Risks

- No migration (`schedule_project_skips` and its notice exist since 279). No new words (the "project gone" text).
- A template whose source is a project folder that has no project row (a leftover folder): unchanged (the turn fails as
  before), because the skip row names a project.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/b-projects-after-update.test.ts`,
the schedule suites (`tests/unit/*schedule*`), `tests/security/project-members-only.test.ts`.

## Result

Built as planned: `templateProjectGone()` in `chat/schedules.ts`, used by `runDue` and `runNow`; the upgrade test
`tests/unit/b-projects-after-update.test.ts` (fails on dev without the change: the template task on the project ran);
the DECISIONS entry "Projects made on 0.4.0: what the owner and admins keep after the update"; the changelog fragment.
No migration and no new words. The two open questions are in the PR.
