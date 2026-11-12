# QA retest follow-ups: the install guide names the AI page as the app does; the Mac update notice names Settings › Apps

- Date (UTC): 2026-11-12 00:34
- Branch: `fix/qa-wording-followups`
- Status: done
- Where: docs/INSTALL.md and desktop/src/common/i18n.ts. Why: wording left over after QA TC-211 and TC-242 (see docs/REPOSITORY-RULES.md)
- Version impact: patch, wording only

## Goal

The 11-12 retest found two leftovers: docs/INSTALL.md still called the AI page "Admin → Connections → Providers" and
"Settings > Providers" (the app says 관리자 › AI 계정 / Admin › AI accounts; QA TC-211 part 3), and the Mac update
notice's Korean detail said "팀 설정 > 앱" while the page is the personal 설정 › 앱 (its button opens /settings/apps; the
English already says "Settings > Apps"; QA TC-242 part 2).

## Result

Both lines changed; `bun run check:docs` and `bun run --cwd desktop typecheck` pass.
