# Saving the AI defaults keeps the unsaved engine-choice ticks

- Date (UTC): 2026-11-11 12:23
- Branch: `fix/ai-defaults-keep-engine-ticks`
- Status: done
- Where: `web/src/pages/admin/TeamAiSettings.tsx` (core web). Why: a bug in the Team settings AI screen (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a bug fix on an admin screen

## Goal

QA TC-217 (P2). Admin › Team settings › AI: an admin picks "고른 부서·사람만" under 엔진 선택 권한 and ticks members
without saving, then changes 기본 모델 and presses that group's Save. The member choice snaps back to "허용 안 함" with no
ticks and its Save bar disappears: the work is lost without a word. Cause: `MemberChoice` resets its local state in a
`useEffect` keyed on `data.memberChoice`, an object; saving the defaults replaces `data` with the server's answer, a new
object with the same content, so the effect runs and throws the unsaved ticks away.

## Scope

In: the effect runs only when the saved member choice really changes (its content, not its object).
Out: the defaults group already keys on plain values and is fine.

## Steps

1. Key the reset on `JSON.stringify(data.memberChoice)` (the same comparison the dirty check uses) and `limitFallback`.
2. e2e in `web/test/e2e/engine-choice.spec.ts`: tick a member, save the defaults, the tick and the choice's Save bar
   are still there.

## Risks

None beyond this screen; no server, migration or text change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, the engine-choice e2e spec.

## Result

As planned. `MemberChoice` keys its reset on the saved choice's JSON. The mock server now stores `defaultModel` like
the server does, so the e2e can follow the QA steps (tick Bob under "고른 부서·사람만", change 기본 모델, save the
defaults: Bob stays ticked and the choice's Save bar stays; it then saves). The new e2e failed without the fix
(the choice snapped back to "허용 안 함") and passes with it.
