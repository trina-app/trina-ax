# Getting started: the end screen names the steps put off, each with a way back

- Date (UTC): 2026-11-11 19:27
- Branch: `fix/onboarding-put-off-steps`
- Status: done
- Where: `web/src/pages/Welcome.tsx` (`DoneStep`, the step routing), the five locales, a short `docs/DECISIONS.md`
  section. Why: onboarding is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: what was put off was lost from sight; nothing about the setup's rules changes

## Goal

QA TC-206 (the rest; the review title for typed answers is PR #461): the owner presses 나중에 하기 on 2/5–5/5. The end
screen says only "준비 끝났어요" + 홈으로; the setup is finished (`finishedAt`), the sidebar's setup row goes and
/welcome goes Home, with 4 of 5 steps put off and nothing saying what is left. Expected: the owner is told what was put
off and can return to it from one obvious place.

## Decision (simplest option that meets the row)

Keep "W6": put off counts as answered, so the setup still finishes. The end screen (the one place every owner sees once
the steps end) lists the steps put off under its buttons, each with **지금 하기**: the step opens right there, and once it
is answered (or put off again) the page comes back to the end screen, which lists what is still put off. One line under
the list says where each can be done later (관리자 › 팀 설정 › 회사 소개, 스킬, 파일, 연결한 서비스, 팀 메뉴의 팀원 초대). A step not offered on this device
(도구 연결 on a phone) is not listed there.

Out: bringing back the sidebar's setup row or /welcome after the setup finished.

## Steps

1. `DoneStep`: the put-off list (counted steps recorded `skipped`, offered here) with 지금 하기.
2. `WelcomeSteps`: a step opened from the end screen returns to it when answered.
3. Strings in EN/KO/ID/JA/ES.
4. Unit test (`web/test/unit/welcome.test.tsx`): the list after steps put off; 지금 하기 opens the step; answered, the
   end screen again without it; nothing listed when none was put off.
5. `changes/onboarding-put-off-steps.md`, a short DECISIONS section.

## Risks

The end screen's one primary stays one (the new buttons are not primary). Phones: 도구 연결 is not offered there. Open PR
#461 edits `ProfileStep.tsx`, not these files.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `web/test/unit/welcome.test.tsx`, the welcome e2e specs.

## Result

Built as planned, with the `docs/DECISIONS.md` section "W6 follow-up: the end screen names the steps put off". The hint
also names where the company profile is later (관리자 › 팀 설정 › 회사 소개).

Checked on a local dev server: an owner with 회사 소개, 스킬, 팀 파일 and 도구 연결 put off opens on 팀원 초대; putting
it off ends the setup and the end screen lists all five with 지금 하기 under "나중에 하기로 남겨 둔 단계예요…" (홈으로
stays the one primary); 지금 하기 on 팀원 초대 opens it, and 완료 brings the end screen back with four left, still on
/welcome. The welcome e2e specs were not run: on dev they fail on the mock server's missing `/api/me/welcome`.
