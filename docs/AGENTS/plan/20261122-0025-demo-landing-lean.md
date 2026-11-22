# Demo landing: lean and visual

- Date (UTC): 2026-11-22 00:25
- Branch: `feat/demo-landing-lean` (off `dev`)
- Status: in progress
- Where: demo-gate/src/pages.ts (the gate's own pages), demo-gate/test/unit.test.ts. Why: the owner on demo.trina.app's
  landing: "주저리 주저리 텍스트가 너무 많음. UI 디자인해" (too much text, design it)
- Version impact: patch, the demo gate's landing look and words; no API, data or behaviour change

## Goal

The free-roam demo landing reads at a glance: the Trina AX wordmark, one short heading, one short line, a row of three
facts (about 8 questions, 24 hours, practice Gmail · Drive), the browser check and one Start button. The full
"practice copies" sentence sits behind a small info toggle on the third fact (details/summary, no script).

## Scope

In:
1. `pages.ts` landing: remove the lead sentence, the 4-line paragraph and the two notes; add the wordmark, a short
   heading and line, the facts row with drawn icons, the practice details toggle. All six languages (en the source).
2. The other gate pages (check, ended, busy, limit, error) share the layout: they get the same wordmark and the same
   lighter frame (no card), nothing else changes in their words or links.
3. Brand colours from editions/trina/branding/logo (ink, paper, the UI orange), light and dark.
4. Tests: old long sentences gone, the facts row and the practice toggle in all six languages, the wordmark matches the
   branding files.

Out: the web app's demo banner, the scripted demo, the gate's routes, Turnstile, cookies, headers, limits.

## Steps

1. Plan and changes note (this commit).
2. The page, its words and tests; screenshots at 1440 and 390, light and dark.

## Decisions

none

## Risks

- Fewer words: "nothing reaches real people" is now carried by "a made-up company" and the practice toggle.

## Tests

typecheck, check:prepush, check:i18n, `bun test demo-gate/test`, tests/unit demo tests.
