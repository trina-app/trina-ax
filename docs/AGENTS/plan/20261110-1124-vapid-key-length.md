# Web Push: a VAPID private key with a leading zero byte is padded to 32 bytes

- Date (UTC): 2026-11-10 11:24
- Branch: `fix/vapid-key-length`
- Status: in progress
- Where: server/src/notifications/push-config.ts and two unit tests. Why: a flaky test that is also a real fault (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A stored push key that lost a leading zero byte works again; no API, data or text change.

## Goal

CI failed once with "Vapid private key should be 32 bytes long when decoded". Node's `ECDH.getPrivateKey()` drops leading
zero bytes, so about 1 in 256 random keys is 31 bytes. Two tests build their key pair that way. The server never makes
keys (no auto provisioning), but an operator who made a key the same way has a `push.json` whose key is 31 bytes:
`readPushConfig` accepts it (ECDH pads it), then every send fails inside web-push.

## Scope

In: pad the private key to 32 bytes when `readPushConfig` loads it; fix the key helpers of the two tests; a test that
loops 2000 keys and a test that loads a 31-byte stored key.
Out: key generation in the product (none), the file format.

## Steps

1. This plan. 2. Pad on load. 3. Tests. 4. Changelog line.

## Risks

None for data: a 32-byte key is unchanged; the public key check still runs.

## Tests

typecheck, push and web-push unit tests, 20 repeats in Linux Docker (oven/bun:1.3.12).

## Result

(filled at the end)
