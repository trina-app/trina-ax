# Three small information leaks: the project dry run, the delete card, the matrix coverage test

- Date (UTC): 2026-11-10 05:27
- Branch: `fix/access-info-leaks`
- Status: done
- Where: Team AX core (`server/src/chat/project-access.ts`, `server/src/chat/delete-files.ts`, `shared/src/api/chats.ts`,
  `web/src/components/ProjectParticipants.tsx`, `tests/security/lib/`). Why: permissions and files are core
  (docs/REPOSITORY-RULES.md).
- Version impact: patch. Two answers say less to members; one optional field in an existing answer; tests.

## Goal

A plan review found three places where a member learns something their permissions do not show them.

1. `POST /api/projects/access-preview` for a new project counts the owner and admins in. Naming a person who is an admin
   does not change the count; naming a member adds one. So any member who may make team projects can ask, for free and
   with no trace, whether a given person is an admin. Members are never told roles (the people directory, rooms).
2. The AI delete card says how many people lose the items and "N of them cannot restore them" (readers without write).
   A member already learns the first number (a copy dry run says how many people read a folder they can write); the
   second one gives away how many people can write the folder, which only admins see.
3. The permission matrix's coverage test (`tests/security/permission-matrix.test.ts`, "every route has a matrix case")
   fails on dev: 46 routes have no case, so a new route without a case is not noticed.

## Scope

In:
1. A new project's dry run, asked by someone who is not the owner or an admin: `people` counts only the caller and the
   people and groups chosen (as if nobody were an admin), and says so (`adminsApart: true`). The line under the picker
   puts the count beside the names chosen and names "팀장·관리자" after it, without a number. Admins get the same answer
   as before. An existing project's dry run (its creator or an admin, who may manage it) is unchanged.
2. The delete card: the "cannot restore" count only for the owner and admins. Others read one sentence with no number
   ("people without write access cannot see it in the trash or restore it"), shown whenever other people lose the items.
   The audit row keeps both numbers.
3. A matrix case for each of the routes without one, written from what each route is meant to allow.

Out: an existing project's counts for its creator (they may manage it; the task leaves them as they are), the overlap
of several items' audiences in the delete card's first number, folder access in place (another branch).

## Steps

1. Failing tests: a unit test per leak (the dry run with an admin named vs a member named, as a member; the card as a
   member and as an admin) and the coverage test.
2. The server changes, the contract field, the web line, the mock.
3. Matrix cases for the routes without one.
4. DECISIONS, CHANGELOG, docs:api; independent deep review.

## Risks

Permissions (never widen; admins keep their answers), the five languages (the card's new sentence), PR #298 rewrites the
project count line (rebase on it if it lands first). No migration.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api` + `tests/unit/docs-site.test.ts`, the unit files for
projects, files/trash/delete and access, `tests/security/permission-matrix.test.ts` and `project-participants.test.ts`,
`test:web` and the project participants e2e spec.

## Result

All three were real, each shown by a test that failed before the fix. Built as planned, plus: the share dry run
(`POST /api/projects/:id/share`, `dryRun`) reuses the new-project count, so it got the same rule; `tests/security` is
not part of CI, so the coverage half of the matrix also runs as `tests/unit/security-route-coverage.test.ts`; two
matrix scopes (`admins`, `own-owner`). PR: https://github.com/trina-app/trina-ax/pull/304
