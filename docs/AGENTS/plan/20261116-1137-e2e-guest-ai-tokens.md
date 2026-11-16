# Web e2e: the guest token-limit specs follow "every guest lands in their place"

- Date (UTC): 2026-11-16 11:37
- Branch: `fix/e2e-guest-ai-tokens`
- Status: done
- Where: `web/test/e2e/`, `web/README.md`. Why: the failing tests and the note on what the suite needs are there (see docs/REPOSITORY-RULES.md)
- Version impact: none (tests and a README line)

## Goal

Three tests of `web/test/e2e/guest-ai-tokens.spec.ts` (`:147` in ko and en, `:162`) time out on `dev` waiting for
`composer-input`, on a computer and in the Feature map workflow. A fourth, `room-file-viewer.spec.ts:355` (a Hangul
file's pages), fails on a computer only.

## Scope

In: make the three guest tests reach the message box the way a guest does now; say in `web/README.md` what the suite
needs before a run.
Out: the other tests the Feature map workflow shows red on `dev`; any product change.

## Steps

1. Reproduce the four on `origin/dev` (chromium) and read the Feature map runs.
2. Guest tests: the spec was written (bcd1ac80f) before "Every guest lands in their group chat or project" (b6d61ff81,
   QA TC-3359, `pages/Home.tsx` `guestLands`). Opening `/` as the tab's first entry is a landing, so a guest with Team
   AI is taken to their group chat and there is no Home message box. Not a product bug: Trina on the rail still opens
   Home for a guest with AI. The tests click `rail-ai`, as `guest-states.spec.ts` and `guest-view.spec.ts` do.
3. Hangul test: the mock team server draws the pages with the pinned rhwp renderer in `native/bin/hwp/`, which
   `bun run prepare:hwp` downloads (the Feature map workflow runs it). Without it the viewer says the preview is not
   available on this server. No HWP spec skips on a missing renderer (`hwp.spec.ts` fails the same way), and a skip
   would hide a broken renderer in CI, so the test stays as it is and `web/README.md` names the step.

## Decisions

None.

## Risks

None for the product. The tests now depend on the rail's `rail-ai` entry, as the sibling guest specs do.

## Tests

`bun run typecheck`; `guest-ai-tokens.spec.ts`, `room-file-viewer.spec.ts:355` and `hwp.spec.ts` three times each
(chromium, after `bun run prepare:hwp`).

## Result

Two edits in `guest-ai-tokens.spec.ts` (click `rail-ai` in place of `page.goto('/')`) and one line in `web/README.md`.
27 of 27 passed over three repeats.
