# A sign-in template says members sign in, not "connect their own key"

- Date (UTC): 2026-11-15 12:58
- Branch: `fix/template-oauth-admin-line`
- Status: done
- Where: trina-ax/web. Why: wording on the template row and dialogs only (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a wording fix with no API or data change

## Goal

Admin › Connected apps: a team template that uses sign-in shows "Each member connects their own key" under its row.
For those templates it should say each member signs in with their own account. Tracking TC-2980 (remaining part).

## Scope

In:
- Admin template row line: pick it by the template's sign-in type (`integrations.template.oauthNote` for sign-in).
- Template dialog "Who it is for" note: a sign-in variant instead of "connect it with their own key".
- Skill share review (welcome): a sign-in tool's done line, and the tools note when every tool or some tools sign in.
- All 6 languages; a web unit test; the e2e assertion in integration-templates.spec.

Out: scheduled-task "needs your own key" notices (the server sends only the template id and name, not its sign-in
type). Unknown names keeping the Korean form particle (by design, PR #964).

## Steps

1. TemplatesView admin line by `tpl.auth`.
2. AccessPicker note by sign-in method in IntegrationDialog.
3. SkillShareReview lines by `tool.auth`.
4. Strings in en/ko/id/ja/es/zh, unit + e2e test, screenshots 1440/390.

## Plain-words check

"Each member signs in with their own account." No sign-in jargon (no OAuth, tokens).

## Risks

None beyond wording. Specs asserting the old string are updated.

## Result

Done. Admin row line, template dialog note and skill share tools lines follow the sign-in type; 5 new strings in 6
languages. Unit test web/test/unit/template-admin-line.test.tsx and skill-share.test.tsx; e2e in
integration-templates.spec (TC-205 test).
