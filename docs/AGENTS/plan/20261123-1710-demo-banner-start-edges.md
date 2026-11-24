# Demo: check the questions-left bar; four Start-button edge cases

- Date (UTC): 2026-11-23 17:10
- Branch: `fix/demo-banner-start-edges`
- Status: done
- Where: demo-gate/ (the landing page's Start script). Why: the script and its tests live there (see docs/REPOSITORY-RULES.md)
- Version impact: patch, fixes to the demo landing's Start button, no new feature or API

## Goal

A visitor who presses Start gets a clear result in every Turnstile edge case, and a tab left open never starts a demo
long after the press. Also settle whether "about 8 questions left" after one answer is right.

## Scope

In:
- The bar: read the code. Finding: correct, no change. The bar and the gate's per-visitor stop both use the visitor
  weight (cache writes at 0.1, docs/decisions/20261121-demo-meter-cache-writes.md). About 81k is the true weight, which
  only the gate's daily cap counts. 8.8k used of 300k leaves floor(291.2k / 35k) = 8, and the bar reads again after
  every answer.
- Start: Cloudflare's retryable timeouts 110600 and 110620 no longer show the error at once.
- Start: an interactive callback after the send cannot cancel the 60 s limit.
- Start: an error after an interactive challenge puts the 45 s limit back on a pending press.
- Start: the automatic start after a press is limited to 3 minutes.
- A test that the Korean page shows its waiting text on an early press.

Out: the demo limit, `DEMO_QUESTION_TOKENS`, other non-retryable Turnstile codes, any deploy.

## Steps

1. demo-gate/src/start-script.ts: the four fixes.
2. demo-gate/test/start-script.test.ts: a test for each, and the Korean page.
3. A real-browser run of the rendered Korean page under the real CSP.
4. changes/demo-banner-start-edges.md.

## Decisions

None. Follows docs/decisions/20261121-demo-meter-cache-writes.md.

## Risks

The inline script's CSP hash is computed from the script, so it follows the edit; a test and the browser run check it.
No migration, no permissions, no app language strings.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, `bun run test:demo-gate`, the demo unit tests.

## Result

- The bar is correct and did not change. It counts what the per-visitor stop counts; the 81k is the daily cap's count.
- Start: the four fixes as planned. The other 110xxx codes still show the error at once. Cloudflare also lists 200100
  and 400020/400021/400070 as not retryable; they keep today's path (three errors or the 45 s limit).
- The Korean page: a unit test on the rendered page, and one local Chromium run under the real CSP with Turnstile
  blocked and its callback called by hand. The live Turnstile widget was not part of that run.
