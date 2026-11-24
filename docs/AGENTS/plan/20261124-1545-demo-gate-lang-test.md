# Demo gate: the language picker test waits for the English warm copy

- Date (UTC): 2026-11-24 15:45
- Branch: `fix/demo-gate-lang-test`
- Status: done
- Where: demo-gate/test. Why: a flaky test in the merge queue's "Demo gate suite" knocks other PRs out of the queue.
- Version impact: none, a test-only change; no shipped code changes.

## Goal

`demo-gate/test/language-picker.test.ts` "an unknown language falls back safely …" fails now and then in the merge
queue (run 45423030530): `/?lang=xx` with an English browser gives `<html lang="en">` but no hidden `lang` input.

Cause: the gate serves the landing (with the Start form) only while the page's language has a warm copy, and the busy
page (no form) otherwise (`public.ts`, `pool.available(locale)`). The pool starts the six languages' copies at once and
they get warm in any order. The test's `beforeAll` waits only for a warm Korean copy, then reads English landings, so
on a slow runner the English copy can still be starting and the visitor gets the English busy page. The gate does the
right thing (a visitor never gets a Start form with no copy behind it); the test waits for the wrong language.

## Scope

In: `beforeAll` waits for a warm `en` and a warm `ko` copy (as `gate.test.ts` already does); the first test also checks
the English page is the landing (its `lang` input), so this cannot hide again.
Out: the gate's code; the live demo.

## Steps

1. Reproduce: with a random 0–1.5 s start delay in the fake instance (local only, not committed), the test fails
   5 of 10 runs with the same error as CI.
2. Fix the wait, rerun with the delay and without it, and run the whole demo-gate suite many times.

## Decisions

none

## Risks

none: test only.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run test:demo-gate` repeated.

## Result

As planned. Reproduced locally with a random 0-1.5 s start delay in the fake instance (not committed): 5 of 10 runs
of the file failed with CI's exact error before the fix, 0 of 20 after. The whole suite passes repeatedly without the
delay. The gate's code is unchanged: showing the busy page while a language has no warm copy is intended.
