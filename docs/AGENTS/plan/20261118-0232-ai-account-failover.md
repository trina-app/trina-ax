# A Claude account whose subscription ended stops every answer

- Date (UTC): 2026-11-18 02:32
- Branch: `fix/ai-account-failover`
- Status: done
- Where: trina-ax `server/src/proxy`, `server/src/chat/turn.ts`, `server/src/credentials`. Why: AI connection failover is core (docs/REPOSITORY-RULES.md)
- Version impact: patch, a server bug fix with no new setting or API

## Goal

QA TC-4835. A team has four Claude subscription accounts: one refused, one at its limit, one whose subscription ended,
one that works. A member's answer fails with "There's a problem with the AI account" and the ended account still shows
"Healthy". The answer should go on with the account that works, and the ended account should show that it was refused.

## Scope

In: on `/v1/messages` only, and only for Anthropic's own error answers (JSON shape + request-id, from Anthropic
itself), the model proxy marks a known account-level 403 and a billing answer (402/400 `billing_error` or the exact
credit phrase), skips any other 403 in the turn only, and holds an API key that is out of credit with its own reason
(no rate limit, no Codex fallback). A Claude turn whose engine reports a sign-in problem the proxy did not recognise
moves on to the next account without marking it, only if no tool ran in the attempt. State lines for an ended
subscription and for out of credit. Tests for each kind of answer, including those that must not mark.
Out: a periodic health check of idle accounts; a drag-to-reorder list (the list already has Move up / Move down);
Codex-side changes (its path already reads 401, plan and credit answers).

## Steps

1. Reproduce with the fake engine and a fake model service (four subscription accounts in the owner's states).
2. `proxy/anthropic-refusal.ts`: the table of answers; `model-proxy.ts` uses it for 400/403 from Anthropic itself.
3. `chat/turn.ts`: an engine `auth` error with no proxy reading switches to the next account.
4. `credentials/store.ts` + `i18n.ts`: the `plan_ended` state line.
5. Unit tests, typecheck, guard tests; decision file and changes fragment.

## Decisions

docs/decisions/20261118-ai-account-failover.md

## Result

The turn goes on to the next usable account. The ended account is marked refused ("Refused", with a line that says its
subscription ended or its plan lacks Claude Code). After review: marking is narrowed to Anthropic's own account-level
answers on /v1/messages; an API key out of credit gets an "Out of credit" hold. Tests: `tests/unit/anthropic-refusal.test.ts`,
`tests/unit/b-credential-failover-kinds.test.ts`.
