# Who sees it: the project's own people first, the owner and admins apart

- Date (UTC): 2026-11-10 16:18
- Branch: `fix/members-count-apart`
- Status: done
- Where: trina-ax core (`server/src/chat/shared.ts`, `server/src/chat/project-access.ts`,
  `server/src/team-files/service.ts`, the shared API types, `web/src/components/ProjectParticipants.tsx`,
  `web/src/lib/folder-access.ts`, `web/src/components/FolderAccess.tsx`, the project page's 멤버 row). Why: projects,
  files and permissions are core (see docs/REPOSITORY-RULES.md).
- Version impact: patch, three optional response fields and new count words; no data change

## Goal

The owner: a project whose members are its creator and the group "leads" (3 people, the creator in it) says "5명이 봐요"
on its 멤버 row and "5명이 봐요 (팀장·관리자 포함)" in the members dialog. "Why 5? leads has 3 people including me." The
other 2 are the owner and an admin, who see every project by role. The number is right but reads as wrong. Now the count
leads with the people who are there because of the project or folder, and the owner and admins come after it, apart and
quieter.

## Scope

In:
- The server splits the count for the owner and admins only: `direct` (people who see it by its own rules, judged as a
  member would be, so an admin in a rule counts once, here) and `byRole` (the owner and admins who see it only by their
  role). On `Project` (`audienceSplit`), the project dry run `POST /api/projects/access-preview` (`split`, new and
  existing projects) and `GET /api/files/audience` (`split`). Same checks as now; the totals stay as they are.
- Members get nothing new. Their totals (`Project.audience`, `ProjectAccess.people`, the existing-project dry run, the
  folder count, the copy dry run) already include the owner and admins, so a `direct` count next to them would tell a
  member how many see it only as the owner or an admin.
- The words, for the owner and admins:
  - the project page's 멤버 row: "멤버 3명" (en "Members 3"); "나만 봐요" and "나와 관리자만 봐요" stay;
  - the members dialog and the new-project line: "멤버 3명 · 팀장·관리자 2명도 볼 수 있어요" (no role part when 0);
  - the folder chip: "3명"; its panel: "3명이 봐요" and "팀장·관리자 2명도 볼 수 있어요" under it;
  - the share switch in the project's edit dialog: "멤버 3명과 팀장·관리자 2명이 …".
- A member's new-project line (#304 `adminsApart`, already without admins): "멤버 2명 · 팀장·관리자도 볼 수 있어요", no
  number for the role part. A member's other counts keep today's words.
- No names of the owner or admins anywhere (#326).
- ko, en, id, ja, es.

Out: splitting the counts members see (the open #304 question: counting admins apart in every count a member gets), the
chat lines ("프로젝트 사람 N명이 이 채팅을 볼 수 있어요"), the copy and delete cards.

## Steps

1. `Audiences.split` (role-blind, as `Audiences.alone`), the fields in the shared types, the three endpoints.
2. Web: `AccessSummary`, the 멤버 row, the folder chip and panel, the share switch line; the mock server.
3. Unit tests (server and web), e2e for the project row and dialog and the folder chip and panel; security tests.
4. DECISIONS, `changes/members-count-apart.md`, `docs:api`; independent review (try to learn the admin count as a member).

## Risks

Permissions: the split must never reach a member (security tests as a member on all three endpoints). #298's dialog
belongs to another session: only the count line and the row's words change. Five languages.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api` + `tests/unit/docs-site.test.ts`, the project, files
audience and access unit tests, `tests/security/folder-audience.test.ts` and `project-participants.test.ts`,
`test:web`, `build:web`, e2e `project-participants`, `folder-access`, `shared-project-chats`.

## Result

Built as planned: `AudienceSplit` (`direct`, `byRole`, role-blind via `policy/access.ts splitOf`) on `Project`, the
project dry run and the folder audience, for the owner and admins only; the new words in five languages. Added on the
way: the project side's role line hangs on one switch (`web/src/lib/whoByRole.ts PROJECTS_BY_ROLE`), so it can go if
projects stop being seen by role; folders keep theirs. A folder's role line has its own key (es "verla", review). The
independent review found no way for a member to learn the admin count through this change, and no must-fix. A member
who manages a project still reads its total ("5명이 봐요"): splitting it would tell them the admin count (#304's open
question). PR: https://github.com/trina-app/trina-ax/pull/341
