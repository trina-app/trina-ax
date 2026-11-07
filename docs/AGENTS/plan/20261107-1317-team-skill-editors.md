# Who can edit team skills: one line on the Team skills page, not two admin columns

- Date (UTC): 2026-11-07 13:17
- Branch: `feat/team-skill-editors`
- Status: in progress
- Where: trina-ax core (`web/src/pages/Skills.tsx`, `web/src/pages/admin/SkillManagers.tsx`, Admin › Members and
  Admin › Groups, i18n, docs). Why: team skills and folder permissions are core features of every team server (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A visible change: "Manages team skills" moves from the Members and Groups tables to one line
  on the Team skills page. No API, rule or migration changes.

## Goal

"Manages team skills" (write access on the team folder `skills/`) is shown in three places: a column on Admin ›
Members, a column on Admin › Groups and a hint on `skills/` in Admin › Folder permissions. The Team skills page itself
does not say who can edit. The owner read the Groups column as a group-level feature. Group skills
(`groups/<folder>/skills/`) are already managed by the members of that group, with no switch.

After this change the owner and admins read, on the Team skills page, near its heading:
`고칠 수 있는 사람: 팀장·관리자, <groups and people> [바꾸기]`. [바꾸기] opens one dialog that lists who can edit
`skills/`, removes a grant and adds a person or group to all of `skills/`. The two columns go.

## Scope

In:
- Team skills page, owner and admins only: one line of secondary text and one text button. The list is what Folder
  permissions says for `skills/` (`GET /api/admin/access/tree?path=skills`, `skillEditorsText`): own rules, groups,
  everyone and the whole team folder; long lists end in "외 N명".
- `SkillManagerDialog` becomes the team-wide picker: the owner and admins as "항상"; every grant (person or group, on
  `skills/` or a subfolder, with its folder) with a remove button that keeps today's confirm, `skillMgr.offStillOn`
  note and server call; one quiet line for editors through other rules (everyone, the team root) with a link to Folder
  permissions; a person-or-group search (the Folder permissions combobox, moved to its own module), then the existing
  `skillMgr.warn` and "팀 스킬 관리 켜기" for all of `skills/`; a link "폴더별로 맡기려면 폴더 권한에서".
- Remove the column on Admin › Members (table and phone rows) and Admin › Groups, `SkillManagerCell`, `skillsVia` and
  the i18n keys left unused.
- Texts that point at the old place: `skillMgr.folderHint`, comments in `SkillManagers.tsx` and
  `server/src/skills/managers.ts`, docs/DECISIONS.md "팀 스킬 관리", docs/PERMISSIONS.md, docs/TRY-IT.md,
  docs/site/use/team-skills.md, docs/guide/guide.html, CHANGELOG.

Out:
- Any server rule, API or audit change. Existing grants keep working.
- Creating new subfolder scopes from the dialog (Folder permissions does that).

## Steps

1. Move `AddNamed` (the person-or-group combobox) out of `AccessEdit.tsx` into `admin/AddNamed.tsx`, with an in-flow
   list for dialogs.
2. Rewrite `SkillManagers.tsx`: `SkillEditorsLine` and the team-wide `SkillManagerDialog`; drop `SkillManagerCell` and
   `skillsVia`. Add `skillEditorsElsewhere` to `lib/access-view.ts`.
3. Put the line on `pages/Skills.tsx` (admins only). Remove the Members and Groups columns.
4. i18n (all five languages), docs, CHANGELOG.
5. Unit tests (`web/test/unit/access-view.test.ts`), e2e (`web/test/e2e/team-skills.spec.ts`: line, dialog, admin vs
   member, add and remove), the mock server if needed.
6. ui-polish + impeccable pass: Team skills, Members, Groups, the dialog; owner / admin / member; 1440 and 390; light
   and dark; Korean and an English spot check; long names and names ending in 님.

## Risks

- No migration. Permissions unchanged: the dialog calls the same `PUT /api/admin/skill-managers` with `path: 'skills'`.
- The line must match Folder permissions for `skills/`: it reads the same server answer.
- The Team skills page loads two admin-only requests for admins only; members never call them.
- Five app languages: every new key in ko, en, id, ja, es.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, the skill-manager and folder-access
unit tests in `tests/unit`, `bun run build:web` and the full web e2e suite (chromium).

## Result

Filled in at the end.
