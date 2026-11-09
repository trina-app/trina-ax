# Team folder basics: Korean folder names on screen, what each folder is for, 양식, the company start in shared/

- Date (UTC): 2026-11-09 08:39
- Branch: `feat/team-folder-basics`
- Status: done
- Where: trina-ax core (`shared/src/folder-labels.ts`, `web/src` Files and pickers, `web/src/i18n`, `server/src/chat/prompt.ts`
  and `chat/file-placement.ts`, `server/src/admin/folders.ts`, `server/src/onboarding/`). Why: files, the AI's
  instructions and onboarding are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. New teams get a different layout (the company start in `shared/`, a `shared/양식/` folder), the
  AI places files differently, the screen shows new folder names; no migration, no API path change.

## Goal

The owner approved small team-folder improvements on 2026-11-09. A new team gets `groups/`, `projects/`, `shared/`,
`skills/` and `users/`, shown with their English disk names. Onboarding puts the company's own material (회사 소개, 브랜드,
회의록, the uploaded company files) in `groups/<회사명>/`, which members who joined another way do not see, so a team has
two company-wide homes. There is no place for forms and templates and no archive convention, and the AI is told which
folders it may write but not what each top folder is for.

## Scope

In:
1. **Folder names on screen (UI only).** `shared` → 전사 공유, `groups` → 부서, `projects` → 프로젝트, `skills` → 팀 스킬,
   `users` → 개인, the person's own `users/<id>` → 내 폴더; the other languages get their own words. One table in
   `shared/src/folder-labels.ts` (the server's instructions name them too); the web shows it in Files (breadcrumbs, rows,
   toasts, upload lines, search scope), the folder picker, the team-file picker, the message box's team file chips,
   Home's team folder line and the 팀 파일 step. Disk names, API paths and the paths the AI sees do not change.
2. **"부서" for admin groups in Korean.** Every ko string that names an admin group (Admin › 그룹, rules, pickers, hints,
   usage, audit, skills shared to a group, the server's ko messages) says 부서. "그룹 대화" (hand-picked group chats) stays.
   The term change goes into DECISIONS.
3. **What each top folder is for, in the AI's instructions.** One line per top folder (with the name people see), the
   templates line ("Forms and templates are in `shared/양식/`: start there…") when the folder is there, and the archive
   convention (finished work moves to a 보관 subfolder of its area when the person asks to tidy up). The loose-file note
   also for a new file directly in `projects/` (in-app AI and the app connector). No UI change.
4. **`shared/양식/` for new teams**, made at the team's start (`createDefaultFolders`), named in the team's language;
   idempotent, and never a second one where a templates folder (any language's name) is there. No department folders.
5. **The company start in `shared/`.** For a team whose start runs from now on, 회사 소개 (the brand folder and 회사
   소개.md), 회의록 and the 팀 파일 uploads go to `shared/브랜드/`, `shared/회의록/` and `shared/<picked folder>/`. The team
   group stays (invite link, team room). The welcome record gets `home: 'shared'`; a row without it (every existing
   team) keeps its group folder: nothing is moved. Readers updated: Home's team files count (`skills/examples.ts`), the
   member's contribute folder (`onboarding/suggestions.ts`), 팀 파일 recorded by the run (`onboarding/team-files.ts`),
   the step labels (`placeName`), the web's 팀 파일 step and Files entry, the mock server.

Out: moving existing teams' files; renaming disk folders; department folders; an archive button; the admin access pages'
folder paths (they set rules on paths and keep them).

## Steps

1. Plan (this commit).
2. `shared/src/folder-labels.ts` + web helper; Files, pickers, chips, Home line.
3. ko 부서 pass (web and server ko strings).
4. Prompt lines (folder purposes, 양식, 보관) and the `projects/` loose note.
5. `shared/양식/` in `createDefaultFolders`.
6. Onboarding in `shared/` and its readers; the mock server.
7. Tests, docs (DECISIONS, for-teams, for-admins, CHANGELOG), screenshots.

## Risks

No migration (highest on dev: 701). Permissions: `shared/` is everyone-write by default, so the company start is now seen
by every member, which is the point; the 팀 파일 step's "who sees it" line counts everyone for `shared/`. Old welcome rows
read as before (`home` absent). Five languages for every new word. Parallel branches touch `prompt.ts` (project and skill
sections) and the projects files: this branch changes only the person lines and the placement rule there.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; unit: the labels map, the prompt lines, `shared/양식`
once and idempotent, onboarding writes to `shared/` and its readers (Home count, contribute folder, landed, step labels),
the onboarding and welcome suites, file placement; the web unit suite in Docker; the full web e2e.

## Result

Built as planned (DECISIONS "Team folder basics"). Differences and choices:
- The labels table lives in `shared/` (not only the web's i18n) because the AI's instructions name the same words; the
  other languages use their own word for groups (Groups, Grup, グループ, Grupos), the one their admin pages use.
- 양식 and 보관 are named in the team's language (양식, Templates, …), like 회의록 and 브랜드; the instructions' templates
  line is English like the rest of the instructions, with the folder as it is on disk, and only when it is there.
- A team keeps the layout its welcome row records: `home: 'shared'` for teams that start from now on, the group's
  folder for every team that started before (their 팀 파일 uploads keep going there). With shared/ as the home, the 팀
  파일 step does not offer the team group's own folder.
- The pack skills 회사 소개서, 카드뉴스 and 홍보 영상 name shared/브랜드/ first (they named only groups/<team>/브랜드/).
- The connector's folder guide got only the projects/ loose-file words (its length budget, 1,700 characters).
- PR: see the branch's pull request to dev.
