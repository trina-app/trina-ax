# Onboarding: next-step label, done-screen rows, desktop-only wording, examples in the viewer's language

- Date (UTC): 2026-11-22 05:15
- Branch: `fix/onboarding-step-labels`
- Status: in progress
- Where: web (pages/Welcome.tsx, lib/welcome.ts, i18n, SkillExampleViewer), server (onboarding/skill-examples.ts, the
  routes that send examples), shared (PackExample.locale). Why: owner screenshots of every step on qa.trina.app (ko)
- Version impact: patch, display fixes (an optional API field is added; nothing is removed)

## Goal

1. The primary on a step names the step that 다음 opens. After ← 이전 (or a phone's ‹), 다음 walks forward one step at
   a time, the same steps the stepper and 이전 show, so "다음: 팀원 초대" never sits on 2/5 while 3/5 comes next. From
   the end screen's 지금 하기 the primary goes back to the end screen and says plain "다음".
2. 준비 끝났어요: 스킬 shows ✓ only when the team has skills from the setup (or shared ones), with "회의록 정리 외 2개";
   else "나중에 하기로 했어요 · 지금 하기". 팀 도구 lists only team connections that are really connected (not "로그인
   필요", "확인 필요", a desktop app away from it, Slack off or failing).
3. "데스크톱 앱에서 쓰여요" → "데스크톱 앱에서만 쓸 수 있어요"; the other languages say the same ("only in the desktop app").
4. Skill examples (EXAMPLE.md text, the intro-deck picture) in the viewer's language when one exists, else as today.
   Done at the routes (GET /api/onboarding/packs, GET /api/skills/examples) and in skill-examples.ts, not in the files
   PR #348 changes (skill-packs.ts, skills/examples.ts). The example says its own language (`locale`), so the
   fictional-company line names the right company.

## Steps

1. Plan (this file).
2. lib/welcome.ts `stepAfter`; Welcome.tsx: one function for where 다음 goes and its label; a back-walk flag.
3. Done screen: skills fact from the pack catalog + shared skills; tools filtered by connectionRowStatus / slackView.
4. i18n desktopOnly in six languages.
5. viewerExample + route post-processing + PackExample.locale + viewer; mock parity for GET /api/skills/examples.
6. Tests: welcome, onb6-*, team-prepared, server onboarding tests. changes/onboarding-step-labels.md.

## Risks

- PR #348's test "the same text language and example for both viewers" compares `example` across a ko and a ja viewer;
  with item 4 the ko viewer gets the Korean example. When both are in one batch that assertion compares `[name,
  locale]` only.
