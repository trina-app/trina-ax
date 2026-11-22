# Onboarding offers everyday office skills

- Date (UTC): 2026-11-21 23:58
- Branch: `feat/onboarding-everyday-skills`
- Status: in progress
- Where: resources/skill-packs, server/src/onboarding, shared/src/api, web. Why: the owner says the setup's skill list
  (company deck, card news, 18 s video, natural writing) is not what people use every day.
- Version impact: minor. Four new skills a team can add, and the catalog's API gains a field (`onboarding`); nothing
  is removed and old apps keep working.

## Goal

The owner's "팀이 쓸 스킬을 골라 주세요" step offers the work people do every week: meeting notes, reports and notices,
customer replies, contract review, natural writing and the company deck. Card news and the promo video leave that list
but stay on Team skills › "트리나가 준비한 스킬 · N개 더".

## Scope

In:
- Four text-only skills in the `work` pack, Korean and English: `meeting-notes`, `team-report`, `customer-reply`,
  `contract-review`, adapted from Apache-2.0 sources (anthropics/skills internal-comms, anthropics/knowledge-work-plugins
  call-summary, meeting-briefing, status-report, draft-response, review-contract) at pinned commits, with LICENSE and
  NOTICE beside each, credits in each SKILL.md, and entries in docs/THIRD-PARTY-NOTICES.md. No bash, scripts,
  connectors or files that do not exist.
- The catalog: new order (the six onboarding skills first, then card news and promo video); each entry says whether the
  setup shows it and whether it starts checked (`onboarding: 'checked' | 'offered' | null`). The setup step shows only
  those, checks the `checked` ones; Team skills shows every kept skill as before.
- One-line descriptions in all 6 languages; a text example (EXAMPLE.md, fictional 예시커피 / Example Coffee) per new
  skill and language, made by running the skill.
- Home's member order (skills/examples.ts MEMBER_ORDER) includes the new skills.
- Decision file, changes file, tests.

Out: deleting or changing installed skills on any team (never), file-format skills (docx, xlsx, pptx, pdf: the
2026-11-20 decision), new tools.

## Steps

1. Fetch the upstream SKILL.md files at pinned SHAs; write the ko and en skills.
2. Server: SKILL_PACKS, CATALOG (+ `onboarding`), SUMMARY, PACK_EXAMPLES, MEMBER_ORDER; shared API field and count.
3. Web: SkillsStep filters and pre-checks by `onboarding`; i18n ×6 (the one lines); the mock server. (The owner
   dropped the planned "Word, Excel, PowerPoint and PDF need no skill" line on 2026-11-22.)
4. Run each new skill once on a short fictional input through the local AI path; keep the outputs as the examples.
5. Tests (catalog, pack install, web unit), typecheck, check:prepush, check:docs; decision, changes, notices.

## Decisions

New: `docs/decisions/20261122-onboarding-everyday-skills.md`. Builds on
[20261120-office-skills](../../decisions/20261120-office-skills.md) (file-format skills stay out) and DS3 / W6 in
docs/DECISIONS.md.

## Risks

- A team that installed the old skills keeps them; installs never replace or delete files.
- Skill names must not take an old pack name (retired-skills.ts LEGACY_PACK_SKILL_NAMES: `meeting-summary`,
  `weekly-team-report` are taken), so the new names differ.
- No migration. Six UI languages; phone rows unchanged.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:docs`, `bun run check:i18n`, tests/unit
b-skill-catalog, c-onboarding-pack, b-skill-examples and the onboarding tests, web unit onb6-skills / welcome /
available-skills-install.

## Result

(filled in at the end)
