# Only skills with a known origin ship; no auto-add

- Date (UTC): 2026-11-08 01:46
- Branch: `feat/skills-known-origin`
- Status: in progress
- Where: trina-ax core (`resources/skill-packs`, `server/src/onboarding`, `server/src/auth/team-links.ts`,
  `shared/src/api`, `web/src`). Why: the packs and the default-skills seeder are core onboarding code
  (see docs/REPOSITORY-RULES.md).
- Version impact: minor. Skills and API routes are removed (`POST /api/onboarding/welcome/pack`, pack ids `marketing`
  and `hr`, the team link's starter) and the background seeder stops; no migration.

## Goal

Most of the 22 skills every team gets were written by AI sessions with no known origin. The owner's order: delete the
skills with no known source, and remove the auto-add (a server loop that re-adds missing default skills 5 s after start
and every 10 minutes), with no "new skills, add them?" prompt in its place.

## Scope

In:
- Keep 4 skills (ko + en): `general/intro-deck` (the onboarding's first result), `general/card-news` and
  `general/promo-video` (each calls a Trina tool of its own), `work/humanizer` (known origin; keep the English MIT
  `LICENSE`, fix the origin comment in `skill-packs.ts`).
- Delete 18: `general/meeting-tasks`, `general/doc-brief`, the whole `marketing` pack (7, and its four `shared/`
  folders), `work/` meeting-summary, weekly-team-report, sales-follow-up, brand-brief, expense-review, new-hire-guide,
  the whole `hr` pack (3). Their files, imports, pack entries, constants, i18n strings (5 locales), docs and tests.
- Remove the seeder: `server/src/onboarding/default-skills.ts`, its timer in `main.ts`, its call in
  `setupWelcomeTeam`. The settings row `onboarding.defaultSkills` stays in old databases, unread. The audit label for old
  `onboarding.default_skills` rows stays.
- Remove what offers or installs the marketing / hr packs: `POST /api/onboarding/welcome/pack`, the Team skills page's
  `MarketingPackLine` and `HrPackLine`. The empty state's one admin button installs the `general` and `work` packs
  (4 skills), with truthful words in 5 locales.
- 할 일 정리 gone: `landingSkill` falls back to no skill (the invite link lands on Home), the end screen shows 홈으로
  only, the team link's starter (team files + "내 할 일 정리해 줘" / "내가 알아야 할 것만 알려 줘") is removed. The general
  pack is recorded when any of its skills is there, so a missing 할 일 정리 never blocks the team's start or loops.
- DECISIONS "DS3", DS / DS2 marked superseded, `docs/site/use/team-skills.md`, CHANGELOG, regenerated API reference.

Out:
- No onboarding redesign: `setupWelcomeTeam` still installs the general pack (now 3 skills).
- Never delete team files: existing teams keep what they have. No migration (the `team_links.starter` column stays,
  unread).
- `examples/skills/` stays (README demo skills); only pointers to the deleted work pack are fixed.

## Steps

1. Delete the 18 SKILL.md folders; trim `SKILL_PACKS`, `SKILL_PACK_IDS`, `DEFAULT_SKILL_PACKS`,
   `OPTIONAL_SKILL_PACKS`, `HR_PACK_SKILLS`, `GENERAL_TASKS_SKILL`, `GENERAL_BRIEF_SKILL`, `WELCOME_PACK_SKILLS`,
   `WELCOME_RESULT_SKILL`, `TEAM_TYPE_PACK`, `REPORT_SKILLS`, `RECURRING_PACK_SKILLS`, the marketing `PACK_FOLDERS`
   (the brand folder name stays as `BRAND_FOLDER`, used by the team's brand folder).
2. Remove the seeder and `installWelcomePack`; `setupWelcomeTeam` records the general pack without 할 일 정리.
3. `landingSkill`, `inviteSkill`, `focusSkill`, `repointDeckLinks` comments: no 할 일 정리 fallback.
4. Remove the team link starter (shared contract, server, web TeamLinkPanel / Home / join page, i18n).
5. Team skills page: one install button for general + work; no pack lines.
6. Demo company (`scripts/demo/acme`): use `work/humanizer` instead of the marketing pack.
7. Tests: delete or rewrite tests of removed behaviour; add a test that no seeder runs and that the 4 kept skills
   install.
8. Docs, CHANGELOG, `bun run docs:api`.

## Risks

- Old welcome rows hold `pack`, `general.tasksPath` / `briefPath`, `teamType: marketing`: read field by field, the
  extra fields are ignored; no row is rewritten.
- Old team links with a starter: the column is no longer read; they land on the link's skill form as any link does.
- API: removed route and fields; web and server ship together.
- Five app languages: removed keys in all five; the new button words in all five.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the onboarding / skills / packs / welcome /
team-links / goal / audit unit tests, `tests/unit/docs-site.test.ts`, `i18n-*`, `bun run test:web`, and the full web
e2e (`bunx playwright test --project=chromium`).

## Result

Filled in at the end.
