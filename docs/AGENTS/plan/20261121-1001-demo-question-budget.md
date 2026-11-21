# Free-roam demo: say up front how many questions a visitor can ask

- Date (UTC): 2026-11-21 10:01
- Branch: `feat/demo-question-budget`
- Status: done
- Where: demo-gate/ (landing page) and web/ (free-roam bar). Why: the gate owns its landing, the web app owns the bar
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a wording addition on the demo's screens with no new feature or API

## Goal

Visitors of demo.trina.app run into the demo limit (300k weighted tokens) without knowing it exists. Tell them up front,
in questions (never "tokens"): a warm question costs about 27k-38k, the first one on a cold cache about 90k, so about 8.

## Scope

In: the landing's line under Start (en, ko); "About N questions left" in the free-roam bar from used/cap
(N = floor(remaining / 35k)), so visitors who resume without the landing see it too; one constant for the 35k.
Out: changing the limit, the 80 % meter or the limit sheet.

## Steps

1. `DEMO_QUESTION_TOKENS = 35_000` in shared/src/api/demo.ts, with where the number comes from.
2. demo-gate/src/pages.ts `note`: "You can ask Trina about 8 questions. Your copy stays for 24 hours." / ko.
3. web/src/lib/freeRoam.ts `demoQuestionsLeft(used, cap)`; null when no limit is known or from 80 % (the meter takes
   over, one count at a time, never "about 0 questions"). Bar shows it after who you are; i18n key `demo.free.left`.
4. Tests: demo-gate page test, web unit (helper, words, bar), e2e bar at 1440/390 light/dark incl. ko.

## Decisions

none

## Risks

Six app languages (ja, es, zh need matching plural forms). 390 layout of the bar: the count stays whole on its line.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run test:demo-gate`, web unit tests,
web e2e demo-free-roam.

## Result

Built as planned. The landing note also got `text-wrap: balance; word-break: keep-all` so the two sentences break
between sentences instead of leaving "24 hours." alone or splitting a Korean word. PR: see the PR to dev.
