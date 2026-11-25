# A new token or key on a connection drops its provider limit (regression tests)

- Date (UTC): 2026-11-25 14:29
- Branch: `fix/token-swap-clears-limit`
- Status: done
- Where: tests/unit (AI connections). Why: the behaviour is already in server/src/credentials; only its tests are missing
- Version impact: none: tests and this plan only, no shipped code changes

## Goal

QA (2026-11-25): the owner's token file on the QA server was replaced after the old subscription hit its weekly limit,
and turns still failed with "used up until 27 Nov 01:00 UTC". It looked like the server kept the old limit. It did not:
the server took the new token (Activity log `credential.secret_replaced`, `limited_until` cleared), sent it, and
Anthropic answered 429 `seven_day` `rejected` with the same reset time for the new token too (a direct check from the
server gave the same answer). The new token's account was used up as well.

So nothing to fix in the server, but nothing tested that a new secret drops a held limit either. This adds that test,
so a later change cannot make a replaced token wait out the old token's limit.

## Scope

In: unit tests for the two ways a connection's secret changes for a Claude subscription:
- the token file gets a new token (`importTokenFile` / `tokenFileTick`): the limit and its code go, the resolver picks
  the connection again;
- the same token written to the file again: the limit stays (it is the same account);
- a new token through Admin › AI providers (`replaceSecret`): the limit goes.

Out: showing in Admin that the new token was tried and is limited too (the row already shows the new end time).

## Steps

1. tests/unit/a-credentials-new-secret-clears-limit.test.ts.

## Decisions

none

## Risks

none (tests only).

## Tests

`bun run typecheck`, `bun run check:prepush`, the AI connection unit tests, web/test/unit.

## Result

Tests added; the server already behaved as wanted.
