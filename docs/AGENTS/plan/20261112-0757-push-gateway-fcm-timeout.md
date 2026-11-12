# Push gateway: a time limit on the FCM and OAuth calls (QA TC-387)

- Date (UTC): 2026-11-12 07:57
- Branch: `fix/push-gateway-fcm-timeout`
- Status: in progress
- Where: `push-gateway/`. Why: the gateway is its own service in this repo (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix in the push gateway with no API change

## Goal

The load test TC-387 lost Android pushes. When an FCM call hangs for longer than about 40 s, this happens:

1. The team server stops waiting after 10 s and tries again 30 s later.
2. The first send is still in flight, so the gateway answers the retry with `200` (duplicate) and sends nothing.
3. The first send then fails and the gateway releases its dedupe entry. Nobody sends the push.

APNs is safe because its HTTP/2 call has a 15 s limit. FCM and the OAuth token call have no limit.

## Scope

In:
- One time limit of 8 s for each FCM send, shared by the OAuth token call and the send call. 8 s is less than the
  team server's 10 s, so the team server gets the gateway's 502 `provider_error` and its retry sends again.
- A unit test for the hang case.

Out:
- Changing the dedupe answer while a send is in flight. The time limit makes the retry come after the first send has
  ended, so this is not needed now.

## Steps

1. `push-gateway/src/fcm.ts`: `FCM_TIMEOUT_MS = 8000`. Send one `AbortSignal.timeout` with the OAuth call and the
   send call. A deps option `timeoutMs` lets tests use a short limit.
2. `tests/unit/push-gateway.test.ts`: a hanging FCM call and a hanging OAuth call answer 502 within the limit, and a
   retry after that sends.
3. README limit line, DECISIONS entry, changelog fragment.
4. Repeat the TC-387 hang probe on the fixed code: 0 lost.

## Risks

None for data or permissions. The limit is on the gateway's own outbound calls only.

## Tests

`bun run typecheck`, `bun test tests/unit/push-gateway*.test.ts`, `bunx tsc -p push-gateway/tsconfig.json --noEmit`,
`bun run check:docs`.

## Result

(at the end)
