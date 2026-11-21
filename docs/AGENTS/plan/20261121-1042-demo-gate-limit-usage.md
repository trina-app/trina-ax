# Demo gate: read the account's unified rate-limit use

- Date (UTC): 2026-11-21 10:42
- Branch: `feat/demo-gate-limit-usage`
- Status: done
- Where: demo-gate/. Why: the gate is the only place that sees the demo account's answers (see docs/REPOSITORY-RULES.md)
- Version impact: none — demo-gate is a private operator tool, not part of the released app

## Goal

Measure how many demo visitors one Claude subscription carries. The gate read `anthropic-ratelimit-unified-status` only
to see "rejected"; it now keeps the account's 5h/7d window use so the operator can relate it to visitor tokens.

## Scope

In: `demo-gate/src/upstream.ts` parses every `anthropic-ratelimit-unified-*` status, reset and utilization header
(numbers and status words only) and keeps the latest in memory; `/__demo/health` shows them under `upstream.limits`;
one `upstream usage` log line per completed messages request (instance id, weighted tokens, 5h/7d utilization).
Out: a dashboard or stored history; any change to what visitors get (the header allowlist stays as it is).

## Steps

1. `parseUnifiedLimits` + `UnifiedLimits` in upstream.ts; read in `noteLimits` on every upstream answer.
2. `status().limits` (health already returns the upstream status object).
3. Log line in `count`.
4. Tests: parsing (unit), health shape + log line + headers stripped (gate test).

## Decisions

none

## Risks

Security: no header value other than a number, a lowercase status word or a reset time is kept; request-id, org id
and the credential are never read. Visitors still get only the response header allowlist (model.ts).

## Tests

`bun test demo-gate/test` (Bun 1.3.12), `bun run typecheck`, `bun run check:prepush`.

## Result

Done as planned.
