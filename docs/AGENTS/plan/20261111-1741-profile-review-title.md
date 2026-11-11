# Getting started: the review after typed answers has a title that fits

- Date (UTC): 2026-11-11 17:41
- Branch: `fix/profile-review-title`
- Status: done
- Where: `web/src/components/onboarding/ProfileStep.tsx`, `web/src/i18n/*`. Why: onboarding is core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch, one title

## Goal

QA TC-206, the title part only. On Getting started 1/5, after "홈페이지가 없어요" and three typed answers, the
review is titled "이렇게 이해했어요" / "Here's what we found", the same as after the AI read a website. Nobody read
anything there: the person typed it. The review after typed answers now says "입력한 내용을 확인해 주세요" /
"Check what you entered". After a website or pasted text was read, and for a saved profile, the title stays.

Out: the put-off steps part of TC-206 (waits for the owner's decision).

## Steps

1. `Phase` review gets `from?: 'answers'`; the questions' Next sets it.
2. New key `onboarding.profile.reviewTitleTyped` in five languages; the review head picks it for typed answers.
3. Test in `web/test/unit/profile-step.test.tsx`: typed answers → the new title; a read draft keeps the old one.

## Risks

None beyond wording. Open PR #428 changes other onboarding strings far from these lines (no conflict).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test web/test/unit/profile-step.test.tsx
web/test/unit/welcome.test.tsx`.

## Result

Built as planned: the review phase carries `from: 'answers'` after the three questions, and its head shows
`onboarding.profile.reviewTitleTyped`. A read draft or a saved profile keeps "이렇게 이해했어요". The new test in
`profile-step.test.tsx` failed before the change. `profile-step` + `welcome`: 81 pass. Typecheck, check:i18n and
check:docs pass.
