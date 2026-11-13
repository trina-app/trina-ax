# Setup 팀 파일: forms become team skills ("이걸 스킬로 만들어둘까요?")

- Date (UTC): 2026-11-12 20:00
- Branch: `feat/setup-forms-skills` (on `feat/setup-files-organize`, PR A)
- Status: done
- Where: trina-ax core (`server/src/onboarding/skill-draft.ts`, new `form-skill.ts`, `shared/src/api/onboarding-skill.ts`,
  `files-organize.ts`, `web/src/components/onboarding/`, `scripts/system/packages.json`). Why: onboarding, skills, files
  and the dev environment are core (docs/REPOSITORY-RULES.md).
- Version impact: minor (one new API route, migration 288 additive, two Debian packages in the dev environment group)

## Goal

The owner's locked plan "Files onboarding — final plan", PR B: a form uploaded at setup gets "이걸 스킬로 만들어둘까요?"
at once. On the 팀 파일 result screen, for the forms the folder plan put in 양식 (at most 3), owners and admins are asked
"견적서 양식, 주간보고 양식을 스킬로 만들어둘까요? 팀원이 '견적서 만들어줘' 하면 이 양식대로 채워요." [만들기] [나중에].

## Scope

In:
- Which forms: rows the plan marked `form: true` that moved into the folder the plan proposed, of a kind a skill can
  fill (.hwp, .hwpx, .xlsx, .docx), at most 3 (`formSkillPaths`). The server takes the form mark off a file whose name
  holds a customer's or company's name (specifics).
- A skill draft from a FILE: `POST /api/onboarding/skill-draft/from-form {path}`; the same draft chat machinery as S
  (onboarding_skill_drafts, `source_path`, migration 288; no source chat or message). The restricted turn reads the
  form's text and answers only title, description and inputs (≤ 3 visible); the steps are fixed by the server.
- The fixed procedure in the SKILL.md: inputs → the newest form in its folder by name stem (ask when missing) → fill a
  copy (edit_hwp with `output`; box_shell python3 openpyxl / python-docx in the start folder) → a new file named from
  the inputs in the person's folder or a folder they name → make_file only when filling fails.
- S's card per form, [팀에 공유] = S's save (humanSave, skills/general/<slug>/SKILL.md).
- python3-openpyxl and python3-docx in the dev environment package group.

Out: an "try it first" step, editing the steps, forms outside setup (later: the Move picker, PR C).

## Checks

typecheck, check:i18n, check:docs, changelog:check, docs:api; tests/unit/b-form-skill.test.ts, the S and organize unit
tests, web/test/unit/form-skills.test.tsx, web/test/e2e/welcome-form-skills.spec.ts (+ organize / team-files specs).
