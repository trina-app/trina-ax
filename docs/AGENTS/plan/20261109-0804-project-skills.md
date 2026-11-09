# Project skills: a fourth skill level that only a project's chats use

- Date (UTC): 2026-11-09 08:04
- Branch: `feat/project-skills`
- Status: done
- Where: trina-ax core (`server/src/chat/skills.ts`, `server/src/skills/`, `server/src/chat/turn.ts`, `tools.ts`,
  `prompt.ts`, `skill-list.ts`, `team-files/service.ts`, `tools/file-moves.ts`, `routes/`, `shared/src/api/`,
  `web/src/`). Why: skills, permissions and projects are core features of every team server (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A new skill level, a new AI tool (`move_skill`), `GET` / `POST /api/skills/move`, new optional
  API fields, one add-only migration (279: scheduled runs skipped because the project is gone).

## Goal

A team asked the AI, in a project chat, to move a lead group's quoting skills into the project "견적". The AI could not
move skills, so it left a README in the project folder as a stand-in. Today a skill is the team's, a group's or one
person's; nothing is "for this project's chats only".

After this change a project on a team folder has its own skills in `<project folder>/skills/<name>/SKILL.md`. They are
used only in that project's chats (private, shared and scheduled), by the people who can see the project. People see
four levels: 팀 전체 · {그룹} 그룹 · {프로젝트} 프로젝트 · 나만. The rule people read is "프로젝트 스킬은 새 이름만 더할 수
있어요": for one name, personal > group > team > project. The AI can move a skill to a level that reaches fewer people,
with a card; moves that reach more people are made on the Skills page.

## Scope

The design review (GO WITH CHANGES) and the owner's option A (team projects live only in `projects/<name>/`, decided
2026-11-09 while this was built) changed the first draft; this is what is built.

In:

1. **The level.** `projects/<name>/skills/<skill>/SKILL.md` of a live team project whose folder is exactly
   `projects/<name>` (not in the trash), only `SKILL.md` folders (a single `.md` there is told it is misplaced, a README
   is a file). No level for a personal project, an older project on another folder or a nested one; a parent project's
   skills are never inherited. One function decides it: `skills/guard.ts projectLevelPossible`.
2. **Who gets them.** The chat's project as `projectForChat` gives it: private, shared and scheduled chats of the
   project, for the people who see it, owners and admins included. Never rooms, never the person's other chats.
3. **Precedence.** "프로젝트 스킬은 새 이름만 더할 수 있어요": personal > group > team > project, by name and by a wider
   skill's file or folder name; "/name" never picks a project skill over a wider one of the same length.
4. **Shared chats.** What everyone who sees the chat may use is picked first, then each name's winner (the list,
   `find_skills`); a project skill never takes a name the sender has at a higher tier; "/name" and the `skill` tool run
   the sender's own skill, after the read card when it is not shared (second review).
5. **Labels and taint.** `[project: <name>]` (one line, cut at 40, no brackets, neutralised) with a note on who writes
   them; `resolveSkill` strips it; the skill block says whose it is and that it grants nothing; "/name" taints.
6. **Who edits.** Whoever may write `projects/<name>/skills` (as group skills, recorded in DECISIONS). The AI's card is
   worded for the project; changes are audited with `project {id, name}`; the creator is told while they read the folder.
7. **Same name.** The save card looks at every level the saver sees: a new project skill under a taken name gets
   [이름 바꿔 저장] [팀/그룹/내 것 고치기, when writable] [저장하지 않기]; a wider save over a project skill's name says
   it hides it. The Skills page's "같은 이름: 팀 전체" chip on such project rows.
8. **The guard** decides by path, no database: any `projects/<name>/skills` (case and Unicode form folded), with or
   without a project (fails closed, like `groups/<g>/skills`). Write approval, move / copy / rename, save_url,
   Higgsfield, room saves, connectors and placement follow. The AI cannot move a folder holding project skills.
9. **Moves.** `skills/move.ts` for the AI's `move_skill` and the Skills page's 옮기기… (`GET` / `POST /api/skills/move`).
   Write on both places, no same name at the target, a SKILL.md folder and no wider same name for a project; a skills
   folder that is not there yet is made. The card gives counts, who may change it there and every file; its yes is
   bound to every file's hash and to who gets and may change it. The AI only moves team → group / project and group →
   project, where nobody new reads or may change it (second review); the rest is the Skills page's, which shows the
   whole text. Refused in scheduled runs, not offered in rooms, shared chats or sub-agents; "먼저 폴더를 프로젝트로 만들어
   주세요" for a plain folder. Audited as `skills.move` (both levels, counts) and each file as `skills.change`.
10. **The refusal text** of the file tools: "Skills do not move with files; ask with move_skill; never make a skills
    folder, README or copy as a stand-in."
11. **Switching on.** A person moving a project's folder into `projects/<name>`, an admin pointing a project at a
    `projects/<name>` with skills, and a personal project shared into `projects/` ask first with the skills' names (409
    `project_skills_on`, then `skillsOk`) and record each (`skills/switch-on.ts`). Project creation itself is the
    project work's (another branch): review MUST 1 and the nesting part of MUST 2 are dropped here.
12. **Scheduled runs.** A task whose project its owner no longer sees is skipped, paused and the owner told once
    (migration 279, add-only `schedule_project_skips`), instead of running without the project.
13. **API.** `GET /api/skills?projectId=` and `?projects=1`, `SkillInfo.project`, `shadowedBy.tier` `team`, `replaces`
    `project`, `SkillChange.project`, `SkillWritePreview.sameName`, `GET` / `POST /api/skills/move`, `skillsOk` on
    `POST /api/files/move`, `InboxNotification.projectGone`, schedule outcome `project_gone`.
14. **Web.** The Skills page's project sections, the chip, 옮기기… and its dialog; the "/" badge inside the project; the
    save card's same-name line; the Files screen's switch-on question; five languages.
15. **Removed.** The project-folder word bonus in `find_skills`; "or the Files screen" in the refusal.

Out (later): sharing to a project from the share flow; project skill usage in Admin › Usage (not recorded, as personal
skills).

## Steps

1. Plan (this file), first commit.
2. Guard and listing: `skills/guard.ts`, `chat/skills.ts`, `chat/skill-list.ts`, `chat/prompt.ts`.
3. Turn and tools: `chat/turn.ts` (list, taint, card, shared-chat order), `chat/tools.ts` (`skill`, `find_skills`,
   `move_skill`), `skills/move.ts`, `skills/changes.ts`, `skills/text.ts`.
4. Every `inSkills` caller, the file-move refusals, the Files move into `projects/`, schedules.
5. Routes and shared API types; `docs:api`.
6. Web: Skills page, move dialog, "/" badge, AskCard, i18n; the web mock and e2e.
7. Docs: DECISIONS, PERMISSIONS, for-teams, CHANGELOG.
8. Tests: `project-skills.test.ts`, `move-skill.test.ts`, cases in c-file-moves, b-rooms-ai, b-shared-chats, the
   permission matrix and a connector refusal; the existing skills, group-skills and skill-share suites.
9. Screenshots before / after at 1440 and 390, light and dark.

## Risks

- **Prompt injection.** A project member writes instructions that everyone in the project follows: names cannot be
  replaced, the AI's write card and the audit apply, the list labels them, nothing is granted, a run taints.
- **Silent switch-on** (step 11) and **widening by a planted message** (step 9: the AI only narrows).
- **Guard coverage.** The guard now reads the database. A failed lookup refuses the write.
- **Migration** 279 (add-only). On dev 276, 277 and 278 are taken.
- **Overlap** with the project work (option A, another branch): this branch leaves `routes/chats.ts`,
  `chat/projects.ts`, `ProjectForm.tsx` and `lib/projectFolders.ts` alone.
- Five app languages, phone and desktop, light and dark.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, the new and touched unit suites,
web unit tests in Docker, `bun run --cwd web build`, `bun run prepare:hwp` and the full web e2e (chromium).

## Result

Built as the Scope above says. The first review's must-changes were applied; the owner's option A narrowed the level to
`projects/<name>/skills/`; the second review (PR #248) changed the AI's moves, shared chats and switching on.

Different from the first draft, and why:
- The guard decides by path (`projects/<name>/skills`), with no database lookup: simpler, and it fails closed for a
  folder no project has yet, like `groups/<g>/skills`.
- The save card does not offer a save under a name a wider skill has (it would never run): another name, or changing
  the wider one. Saving a wider skill over a project skill's name only warns.
- The AI's `move_skill` only narrows by level (team → group / project, group → project) and by people (nobody new
  reads it or may change it); a planted skill can never move itself into a person's own skills. Widening moves are the
  Skills page's, which shows the whole text.
- In shared chats a project skill never takes a name the sender has, and "/name" runs the sender's own skill after the
  read card, as before this branch.
- The `move_skill` guidance is in the tool's description, not in the skills section: that section stays the same for
  every engine and the sub-agents.
- A scheduled run whose project is gone is skipped and the task paused, with its own add-only table (migration 279):
  `schedule_outcomes` has a fixed CHECK list. 276-278 were taken on dev while this was built.
- A side chat beside a room gets project skills only when it belongs to the project (it is made without one).
- Project skill uses are not recorded in Admin › Usage (as personal skills); left for later.

Tests and their counts are in PR #248.
