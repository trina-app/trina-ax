# Every way out of the welcome steps has a way back

- Date (UTC): 2026-11-14 12:31
- Branch: `fix/onboarding-exit-ai-accounts`
- Status: done
- Where: Team AX core, `web/` (onboarding components, Admin layout, project page). Why: the welcome steps are core
  onboarding (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to an existing flow

## Goal

The owner clicked the AI step's "Other AI services such as OpenRouter: Admin › AI accounts" and landed in Admin with
no way back to the steps. On a computer the setup row is not on Admin pages, and without AI it opens the connect
dialog, not the steps; on a phone the bar's ‹ says "Admin". Every exit from the steps must lead back.

## Scope

In:
- Audit every link and button that leaves `/welcome` (pages/Welcome.tsx and components/onboarding/*).
- A link out of the steps to another app page carries the step it left in the history entry's state
  (`lib/welcome.ts setupReturnState`, like the existing `INVITE_STEP_STATE` and `LANDING_STATE`).
- That page shows one small control (`components/onboarding/SetupReturn.tsx`): "← Back to getting started"; after the
  AI step, once AI answers (an account added there, or in another tab), "Continue setup" in the accent. It opens
  /welcome, which already resumes on its own (AI step recorded done once AI answers).
- Used by the AI step's engines line (now straight to /admin/providers, the old address's redirect dropped the state)
  and 팀 파일's "Open" of the project it made. Home's no-AI card keeps its plain link.

Out: exits that are meant to leave (나중에, the end screen's Home and skill), which the setup row and Home's row already
lead back from; links that open a new browser tab (website, sign-ins).

## Steps

1. `setupReturnState` / `setupReturnStep` in lib/welcome.ts.
2. `SetupReturn` component; rendered at the top of Admin (computer and phone) and the project page.
3. The two links pass the state only on /welcome.
4. i18n `welcome.returnBack` (en first, then ko/id/ja/es/zh); "Continue setup" reuses `setupRow.resume`.
5. Unit and e2e tests; screenshots 1440/390, light/dark.

## Risks

No migration, no server change. The state is per history entry: a reload keeps it in Chromium, another page drops it
(the setup row is the way back from everywhere else). Phone: the control goes back in the history when the entry
under the page is the steps, so ‹ does not walk the steps twice.

## Tests

`bun run typecheck`, `bun run check:i18n`, web unit tests (`test/unit/setup-return.test.tsx`), e2e
`test/e2e/welcome-exits.spec.ts` and `no-ai.spec.ts`; screenshots with `WELCOME_EXITS_SHOTS`.

## Result

Built as planned. Exits found from /welcome: the AI step's engines line and 팀 파일's project **Open** (both now carry
the step and show the way back); 나중에 and the end screen's Home and skill (meant to leave; the setup row, Home's row
and the no-AI card lead back); new-tab links (website, sign-ins) that leave the steps open; the invite step's "add
skills · add files" (step switches inside /welcome). One addition: the control also asks for AI again on window focus,
because a subscription's sign-in happens in another tab.
