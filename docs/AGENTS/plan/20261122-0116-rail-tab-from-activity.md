# A rail place always responds, also from a chat opened in 활동

- Date (UTC): 2026-11-22 01:16
- Branch: `fix/rail-tab-from-activity`
- Status: done
- Where: web/ (lib/rail.ts). Why: the rail belongs to the web app, which the desktop app shows (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no new feature or API

## Goal

The owner opened a notice in 활동 ("…에서 부탁한 작업을 트리나가 마쳤어요"). Its Trina chat opened on the right with 활동
still lit. Pressing 트리나 in the rail then did nothing: 활동 stayed lit and its list stayed. Every rail place must
switch the list and light itself, whatever the main pane shows.

## Cause

트리나 remembers the last AI chat it showed (lib/rail.ts `rememberRail`). When that chat is the one 활동 opened, the
rail's 트리나 link goes to the address already on screen with no state. React Router turns that into a replace of the
same address, and `railHereKept` reads "same path, no state" as the page tidying its own address, so it keeps 활동 lit.
The running turn is not the cause. That notice (dev_env.job, "'…'에서 부탁한 작업을 트리나가 마쳤어요") opens \`/c/<chat>\`,
the same route shape as other notices; what sets it apart is that its chat is nearly always the one 트리나 showed last,
because the job ran in the chat on screen. A notice for any chat 트리나 showed last does the same.

## Scope

In: a press on a rail place always names its place in the entry's state (`railLinkState`), so the kept place gives
way to it. A unit test and an e2e test for the case, and a pass over the other places from the same state.
Out: the English work notes in that chat (reported separately).

## Steps

1. `railLinkState` returns `{ rail: item }` for every press.
2. Unit test in web/test/unit/rail.test.ts; e2e in web/test/e2e/activity-panel.spec.ts: open a chat in 트리나, open its
   notice in 활동, press 트리나 (and each other place).
3. changes/rail-tab-from-activity.md.

## Decisions

None.

## Risks

Phone tabs do not use the rail. Back and Forward keep each entry's own state, unchanged.

## Tests

`bun run typecheck`, `bun run check:prepush`, web unit tests for the rail and activity, e2e rail.spec and
activity-panel.spec.

## Result

Built as planned, plus the \`railHereKept\` guard in step 1, which the e2e for 활동's 멘션·스레드 line asked for. The e2e
uses a dev_env.job notice, failed before the fix (트리나 stayed unlit with its link on the chat on screen) and passes
after it.
