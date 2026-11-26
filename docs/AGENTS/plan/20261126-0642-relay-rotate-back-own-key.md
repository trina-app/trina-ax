# Relay: operator key rotation can give a team its earlier key back

- Date (UTC): 2026-11-26
- Branch: `fix/relay-rotate-back-own-key`
- Status: done (PR #624)
- Where: relay/src/registry.ts, relay/src/ops-api.ts, tests/unit/f-registry.test.ts
- Version impact: patch (relay bug fix; the operator API accepts one more case, the team API does not change)

## Problem
After a failed R2 restore the CP rollback rotates the relay key back to the old VM. The registry refused it
(409 key_in_use: the revoked row still holds the key), so the team stayed offline. Seen in prod on 2026-11-26.

## Fix
`Registry.rotateKey(…, { reuseOwn })`: a revoked key of the same team becomes live again; the live key again is no
change; a key of another team is refused. Only the operator API sets `reuseOwn`. The team API (`api.ts`) still refuses
every known key.

## Tests
tests/unit/f-registry.test.ts: rotate back with reuseOwn, the team path refused, another team's key refused.
