# Onboarding polish: the phone's end screen and the greeting name

- Date (UTC): 2026-11-20 13:24
- Branch: `fix/onboarding-finish-phone-and-greeting`
- Status: done
- Where: web/src (Welcome end screen, Home member card). Why: two QA findings on qa.trina.app build
  0.5.22-dev.20261120121357, both screen-only (see docs/REPOSITORY-RULES.md)
- Version impact: patch, two wording/state fixes on existing screens, no API or data change

## Goal

1. On a phone the team setup has 4 steps: it walks past 팀이 쓸 도구. The end screen (PR #93) still ticked "팀 도구",
   because the server marks a put-off 도구 연결 done once the team has any working connection (settlePutOff), and the
   end screen reads that. The summary must only say what this setup did.
2. The Home card greeted "QA Member" as "QA님": the name helper takes the first word of a Latin name in every language.

## Scope

In:
- End screen: a step this device does not offer (도구 연결 on a phone) is always the neutral row "컴퓨터에서 할 수 있어요",
  never a tick, whatever its stored state.
- One helper `greetName(name, locale)` in `web/src/lib/greetName.ts` for every greeting by name: the member and owner
  Home card titles, the owner's name on the no-AI row, Home's "{name}님, 무엇을 도와드릴까요?".
  Korean, Japanese and Chinese (the UI language, or a name in those scripts): the full name ("QA Member님", "김민지님",
  the existing convention: no given-name guess). Other languages: the first word ("Mina"). Words with no letter or
  digit (emoji) are dropped; a name that is only emoji stays as it is.
- Unit tests: the helper (Korean, English, single word, emoji), the phone end screen with tools settled done.

Out: the server's settlePutOff rule (it keeps stopping the setup row's nag); a given-name guess for Korean names.

## Steps

1. Plan commit.
2. `greetName` + tests; use it in MemberWelcome.tsx and Home.tsx; drop `firstName`.
3. DoneStep: `elsewhere` = not offered here; test.
4. changes/onboarding-finish-phone-and-greeting.md; screenshots 390/1440 ko/en on the mock.
5. typecheck, check:prepush, web unit tests for welcome and member-welcome.

## Decisions

- Neutral row instead of tracking "what this setup did": the leaner of the two options. A phone never does 도구 연결,
  so its end screen never ticks it; the rare owner who did it on a computer first and finished on the phone sees the
  neutral line, which is still true.

## Result

- `web/src/lib/greetName.ts`: one helper for the member and owner Home card titles, the hi button, the owner's name on
  the no-AI row and Home's greeting. "QA Member" → "QA Member님" (ko), "QA" (en); Korean names stay whole.
- End screen: `elsewhere` is any step this device does not offer; a phone's row for 팀 도구 is always neutral.
- Tests: web/test/unit/member-welcome.test.tsx (the helper), web/test/unit/welcome.test.tsx (a phone's end screen
  with 도구 연결 settled done). Screenshots at 390 and 1440 in ko and en on the mock.
