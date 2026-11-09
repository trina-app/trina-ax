# Project skills: a fourth skill level that only a project's chats use

- Date (UTC): 2026-11-09 08:04
- Branch: `feat/project-skills`
- Status: in progress
- Where: trina-ax core (`server/src/chat/skills.ts`, `server/src/skills/`, `server/src/chat/turn.ts`, `tools.ts`,
  `prompt.ts`, `skill-list.ts`, `team-files/service.ts`, `tools/file-moves.ts`, `routes/`, `shared/src/api/`,
  `web/src/`). Why: skills, permissions and projects are core features of every team server (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor. A new skill level, a new AI tool (`move_skill`), `POST /api/skills/move`, new optional API
  fields, one add-only migration (scheduled runs skipped because the project is gone).

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

In:

1. **The level.** `<p>/skills/` of a live team project (not in the trash), only `SKILL.md` folders (no single `.md`, a
   README is ignored). No project level for a project on the team root, under `users/`, on a group folder
   (`groups/<g>`), or anywhere inside a skills root. Nested projects: only the chat's own project counts; a parent
   project's skills are not inherited.
2. **Who gets them.** The chat's project as `projectForChat` gives it (sees the folder, not in the trash): the person's
   private project chats, shared project chats, and scheduled runs in the project. Never rooms (no project there), never
   the person's other chats. Owners and admins too, in their own project chats.
3. **Precedence.** personal 0 > group 1 > team 2 > project 3. A project skill whose name, or the file / folder name
   ("/alias") of a wider skill, is already taken is hidden. In `invokedSkill` ("/name") the project level sorts after
   every wider skill at the same length, alias or not.
4. **Shared chats.** The audience filter runs before the winner is picked (skills nobody else may use drop out first),
   in the turn, the `skill` tool and `find_skills`.
5. **Labels and taint.** The AI's list marks them `[project: <name>]` (brackets stripped, neutralised, cut at 40), with a
   note that anyone who writes the folder may have written them; `resolveSkill` strips the tag; the skill block says
   whose it is; a project skill run with "/name" or loaded with the `skill` tool taints the session (outside content),
   like project instructions. No tools are granted.
6. **Who edits.** Whoever the folder rules let write `<p>/skills` (as group skills: recorded in DECISIONS). The AI's
   write goes through the existing card, worded for the project ("프로젝트 '견적'의 스킬로 저장할까요? 이 프로젝트 채팅에서
   AI가 따라요"). Every change is audited as `skills.change` with `project {id, name}`; the notice goes to the owner,
   admins and the project's creator while the creator can read the folder.
7. **Same name elsewhere.** The save and move cards look at every level the person sees. A project-level save whose name
   is used elsewhere is not offered under that name: "'견적'이 팀 전체에 있어 이 프로젝트에선 그게 쓰여요" with
   [이름 바꿔 저장] [팀 것 고치기] (only when they may write that one) [저장하지 않기]. Saving a wider skill over a
   project skill's name says the project's copy will be hidden. The Skills page puts a small "같은 이름: 팀 전체" chip on
   such project rows only.
8. **The guard.** `inSkills` / `skillRootOf` take the database: live projects with a project level, compared with case
   and Unicode form folded. A failed lookup fails closed (treated as inside a skills root). Every AI-side write path
   that checks `inSkills` today (write / edit / make_file approval, move / copy / rename, save_url, Higgsfield, room
   saves, connector uploads, file placement, room change cards) then covers project skills.
9. **Moves.** One server action, `moveSkill` (`server/src/skills/move.ts`), for the AI's new `move_skill` tool and the
   Skills page's "옮기기…" (`POST /api/skills/move`, with a preview step). Write on both sides, no skill of that name in
   the target, a SKILL.md folder for a project target, the target project live. The card says who gains and who loses
   it with counts ("리드 그룹 6명 → 견적 프로젝트 채팅 4명") and lists every file of the folder; the approval is bound to a
   hash of every file and checked again at move time. **The AI's `move_skill` only narrows** (nobody gains); a widening
   move is refused with a pointer to the Skills page, which shows the whole SKILL.md. Refused in scheduled runs; not
   offered in rooms or shared chats; "먼저 폴더를 프로젝트로 만들어 주세요" when the folder is not a project. Audited
   (`skills.move`: both levels, gained / lost counts) plus the `skills.change` rows of the file events.
10. **The refusal text** of the file tools for skill roots: "Skills do not move with files; ask with move_skill; never
    make a skills folder, README or copy as a stand-in." The AI cannot move a folder that holds a project's skills (as
    a group's).
11. **Skills that switch on.** Making a project on an existing folder, pointing a project at another folder, sharing a
    personal project to the team and restoring a project folder from the trash can turn existing `<folder>/skills/*/
    SKILL.md` files into live skills. These ask first ("이 폴더의 스킬 N개가 이 프로젝트 채팅에서 켜져요: …", a 409 with
    the list, then the same request with `skillsOk`) and audit each skill as `skills.change` (`change: 'enable'`).
12. **Nesting.** A project folder may not be inside a skills root (team, a group's, another project's `skills/`); an admin
    move that would put a project there is refused.
13. **Scheduled runs.** A task whose project its owner can no longer see is skipped and the owner is told, instead of
    running outside the project (today the run's chat drops the project). One add-only migration,
    `276_b_schedule_project_skips.sql`, as `schedule_template_skips`.
14. **API.** `GET /api/skills?projectId=` (the "/" menu inside a project chat), `?projects=1` (the Skills page's project
    sections, each skill with `project` and, when hidden, `shadowedBy`), `SkillInfo.project`, `shadowedBy.tier` gains
    `team`, `replaces` gains `project`, `SkillWritePreview.sameName`, `POST /api/skills/move`, `skillsOk` on project
    create / update / share and trash restore.
15. **Web.** Skills page: a section per project with skills, "{project} 프로젝트 스킬" with the hint "이 프로젝트 채팅에서만";
    "옮기기…" in the row menu (a small dialog: level, who gains and loses, the whole text when it reaches more people);
    the "같은 이름" chip. The "/" menu's project badge inside that project only. The save card's same-name line. The
    skills-switch-on confirm. Five languages.
16. **Removed or simplified.** The project-folder word bonus in `find_skills`. The "or the Files screen" refusal text.

Out (later): sharing to a project from the share flow, project skill usage in Admin › Usage (project skill uses are not
recorded, as personal ones), a project skill's own form of approval for editors.

## Steps

1. Plan (this file), first commit.
2. Guard and listing: `skills/guard.ts`, `chat/skills.ts`, `chat/skill-list.ts`, `chat/prompt.ts`.
3. Turn and tools: `chat/turn.ts` (list, taint, card, shared-chat order), `chat/tools.ts` (`skill`, `find_skills`,
   `move_skill`), `skills/move.ts`, `skills/changes.ts`, `skills/text.ts`.
4. Every `inSkills` caller, the file-move refusals, project create / update / share / restore, schedules.
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
- **Migration** 276 (add-only). Highest `b` on dev is 275.
- Five app languages, phone and desktop, light and dark.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, the new and touched unit suites,
web unit tests in Docker, `bun run --cwd web build`, `bun run prepare:hwp` and the full web e2e (chromium).

## Result

Filled in at the end.
