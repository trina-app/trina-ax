# Projects live only in `projects/`; members make them and choose who sees them

- Date (UTC): 2026-11-09 08:37
- Branch: `feat/projects-in-projects`
- Status: done
- Where: trina-ax core (`server/src/routes/chats.ts`, `server/src/chat/projects.ts`, a new
  `server/src/chat/project-access.ts`, `server/src/admin/` (settings, users, groups), `server/src/team-files/service.ts`,
  `shared/src/api/`, `web/src/components/ProjectForm.tsx`, `web/src/pages/Projects.tsx`, `web/src/pages/Files.tsx`,
  Admin › Team settings). Why: projects, folder permissions and files are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. New endpoints, a team setting and an add-only migration (277); creating a project on an
  existing folder and the old share copy are refused (older clients get a 400 that says where projects go).

## Goal

The owner decided on 2026-11-09: a team project lives only in `projects/<name>/`, a personal one only in
`users/<me>/projects/<name>/`. Any member can make a team project (like a Slack channel) and choose who sees it; an
admin can limit that to admins. The creator and admins see and change who sees it from the project's edit screen.
Today a member can only make a project on a folder they can already write, the dialog never says who sees it, and only
admins can change that, in Admin › Folder permissions.

## Scope

In:
1. **Where.** Create: team → always a new `projects/<name>` (a taken name gets "-2"; a `folderPath` other than
   `projects/<name>` is 400), personal → only `users/<me>/projects/<name>`. The "기존 폴더" kind is gone. Sharing a
   personal project makes a new `projects/<name>` with participants and copies the files into it (no other target).
   Repoint stays for admins only, only for a project whose folder is in the trash or missing, only to an existing
   `projects/<name>` no other project uses.
2. **Private by rule.** A new project folder gets each participant and the creator `write`, plus `everyone: none`, so an
   admin's root `everyone: read` cannot open it. Deleting a person or a group never leaves a project folder in
   `projects/` with no rules: the `everyone: none` floor stays (also for older project folders that lose their last
   rule that way).
3. **Created as the system.** Members have no write on `projects/`: the server checks the member may make projects
   (the admin switch), then makes the folder as the system (as `resolveFolderPath` does), never as the caller.
4. **Who may create.** Team setting `projectCreators: 'members' | 'admins'` (default members), enforced on create and
   share; `Me.team.projectCreators` tells the web.
5. **One writer for participants.** `GET /api/projects/:id/access` (creator and admins): participants, the rules this
   screen does not change (read-only people or groups, roles, everyone other than the floor, rules inside the folder;
   shown read-only with a pointer to Admin), `rulesHash`, people count. `PUT /api/projects/:id/participants` saves like
   Admin › Folder permissions: `replaceRules` with the `rulesHash` check (409 `rules_changed`), `captureState` /
   `afterAccessChange` (sessions, notices, shared chats dropped for people who lost the project), audit `folder.rules`
   with `via: 'project'`. The creator's rule is always kept. A member adds only their own groups (groups already there
   may stay) and active people.
6. **Widening confirm by a server dry run.** `POST /api/projects/access-preview` (the creator or an admin for an
   existing project; anyone who may create for a new one): how many people would see it, who gains and loses, and for
   the people who gain it: files others put there, shared project chats (whole history), project skills
   (`<folder>/skills/*/SKILL.md`, counted by path). The web asks once when someone gains it; narrowing saves directly.
   People who saw the project before get a notice when it widens.
7. **Delete.** Deleting a team project in `projects/` offers to put its folder in the trash (the creator could not trash
   a folder that carries rules otherwise).
8. **Files.** "프로젝트로 만들기" goes; "프로젝트 열기" stays. Projects on other folders keep working, unchanged, no
   migration and no label for members; admins see one line in the edit dialog.
9. **Web.** Create dialog: 팀 프로젝트 (default) / 내 프로젝트, a participant picker (people from `/api/people`, a
   member's own groups from `me.groups`, admins every group), and always "볼 수 있는 사람: 영업 부서 · 김소라 ·
   팀장·관리자 (9명)". Edit dialog: the same picker and line, the read-only rules, the widening confirm. Share dialog: the
   picker. Admin › Team settings: the switch. Five languages, groups called 부서 in Korean copy.

Out: moving older projects into `projects/` (no migration, no button), a project member list separate from folder rules,
project skills themselves (feat/project-skills).

## Steps

1. Shared API: bodies, `ProjectAccess`, preview, setting, `Me.team.projectCreators`; `docs:api`.
2. Server: `chat/project-access.ts` (participants, preview, save), create / share / update / delete in
   `routes/chats.ts`, `TeamFiles.copyFolderInto` and the delete trash option, the floor in `admin/users.ts` and
   `admin/groups.ts`, the setting.
3. Web: ProjectForm, share and delete dialogs, Files menu, Team settings, the mock server, i18n.
4. Tests: `r1-project-create` (members, switch, refused places, floor), new `project-participants.test.ts`, the removed
   paths' tests (project-is-folder, r2-project-folder-unlock, r3-project-folder-repoint), every suite that made projects
   on existing folders (an older-project helper inserts the row as older builds did), permission-matrix rows, a
   ProjectForm web unit test, a new e2e spec.
5. Docs: DECISIONS, PERMISSIONS, for-teams, CHANGELOG.
6. Screenshots before / after at 1440 and 390, light and dark.

## Risks

- Permissions: members now make folders with rules. Each new folder is private by rule and capped by the same name
  rules; the "-2" suffix tells a member that a folder of that name exists (accepted, DECISIONS).
- Two writers (Admin › Folder permissions and the project screen): both go through `replaceRules` + `rulesHash` +
  `afterAccessChange`, so neither undoes the other unseen.
- Coordination: feat/project-skills changes skills files; this branch does not touch them (skills are counted by path).
- One add-only migration, 277 (`projects.folder_made`), added after the review; feat/project-skills takes 276. No data
  migration of older projects. Five app languages, phone and desktop, light and dark.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, the touched server suites, web unit
tests in Docker (bun 1.3.12), `bun run --cwd web build`, `bun run prepare:hwp`, the full web e2e.

## Result

Built as planned: `chat/project-access.ts` (participants, the dry run, the save, the system-made folder), create / share /
repoint / delete in `routes/chats.ts`, `TeamFiles.copyFolderInto` and the delete's folder trash, the floor on person and
group deletion, `TeamSettings.projectCreators`, the dialog's picker and "볼 수 있는 사람" line, the widening confirm, the
share dialog, Files without "프로젝트로 만들기", the Team settings switch, five languages, docs.

Changed from the plan:
- **Migration 277** (`projects.folder_made`, add-only), after the independent review: a member's project made by an older
  build on an existing admin-ruled `projects/<name>` would otherwise have let that member rewrite or trash it. Only a
  folder the server made is its creator's; admins change any.
- The access answer gives a member the count only (no rules hash) for a project they may not change, and names rule
  folders inside only when they can read them; the dry run counts only files the caller can read (review).
- Trashing the project folder still refuses anything managed inside it for a member, and runs before the delete stops
  chats (review).
- Naming a person or group with a rule set in Admin › Folder permissions is refused (400 `participant_fixed`) instead of
  silently doing nothing.
- The web mock still takes a `folderPath` from specs (fixtures of older projects); the real server refuses it.

PR: see the branch `feat/projects-in-projects`.
