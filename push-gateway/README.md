# push-gateway

Team servers call this service to send a native push to the iOS/Android app. Only the gateway holds the Apple (APNs)
and Google (FCM) credentials. It talks to APNs and FCM HTTP v1 directly; it does not use the Expo push service.

- Contract: [`shared/src/cloud-protocol/push-gateway.ts`](../shared/src/cloud-protocol/push-gateway.ts) (MIT, no
  imports). `POST /v1/send` with a JSON body, signed with the team's Ed25519 key (`Authorization: MycelPush …`).
  `GET /health` answers `{"ok":true}`. Every other path answers 404.
- Team identity is its public key: key id = sha256 hex of the SPKI DER. Trust on first use: a key the gateway has not
  seen is accepted and its first-seen time is recorded. An operator can block a key, which then gets 403.
- Limits (`src/state.ts`, `LIMITS`):
  - per team key: 120 a minute while the key is young (first seen less than 24 h ago), 1200 a minute after that;
  - per device token: 20 a minute and 200 a day (UTC);
  - dedupe: the same (key, token, notificationId) within 10 minutes is answered 200 and not sent again. This is also
    the replay guard inside the ±5 minute timestamp window.
  - A refused or failed send is not remembered, so a retry sends.
- Text: the push never carries message content (App Review 4.5.4). The title is `APP_TITLE`; the body is a generic
  line picked from `code` and `locale` (`src/text.ts`).
- Logs: only `{evt, outcome, platform, status}`. The gateway never logs tokens, bodies, keys, signatures or provider
  answers.

## Files

| File | What |
|---|---|
| `src/gateway.ts` | the request handler, shared by both entries |
| `src/apns.ts`, `src/fcm.ts` | providers: APNs token auth (ES256 JWT), FCM HTTP v1 (RS256 assertion → OAuth token) |
| `src/state.ts` | TOFU, limits and dedupe over a small storage interface; in-memory state for tests |
| `src/worker.ts` | Cloudflare Worker entry: `BLOCKED` KV (operator blocklist, read-only for the Worker) + `PushLimiter` Durable Object (one per team key and one per device token) |
| `src/bun.ts` | Bun entry: APNs over `node:http2`, state in one SQLite file |

## APNs needs HTTP/2: Worker or Bun?

APNs accepts only HTTP/2. Cloudflare does not document which HTTP version a Worker's outbound `fetch()` uses:

- [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) and
  [Protocols](https://developers.cloudflare.com/workers/reference/protocols/) say nothing about it.
- The only Workers statement is the
  [2019-09-19 changelog entry](https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/):
  "Cloudflare communicates with origin servers using HTTP/1.1, not HTTP/2."
- [HTTP/2 to Origin](https://developers.cloudflare.com/speed/optimization/protocol/http2-to-origin/) is a setting for
  proxied zone traffic. That page does not mention Workers subrequests.

So the Worker is only known to work for FCM. Before relying on it for iOS, deploy it to a test route and send one push
to a real sandbox or production token. A Worker that cannot reach APNs answers 502 `provider_error` for iOS.

The Bun entry runs the same handler, with APNs over `node:http2`, so it can run on a small server instead.

## Tests and typecheck

```sh
bun test tests/unit/push-gateway.test.ts tests/unit/push-gateway-entries.test.ts
bunx tsc -p push-gateway/tsconfig.json --noEmit
```

The tests use fake APNs, FCM and OAuth endpoints (an injected `fetch`, plus a local HTTP/2 server for the Bun entry).
Their keys are generated at runtime. The root `bun run test:unit` and `bun run typecheck` cover these files too.

## Secrets and variables

| Name | Kind | What |
|---|---|---|
| `APNS_PRIVATE_KEY` | secret | the `.p8` key (PKCS#8 PEM; one line with `\n` written out also works) |
| `APNS_KEY_ID` | secret or var | the key's id from the Apple developer account |
| `APNS_TEAM_ID` | var | Apple team id (`wrangler.toml`) |
| `APNS_TOPIC` | var | the app's bundle id (`wrangler.toml`) |
| `APNS_SANDBOX` | var | `on` also sends to the APNs sandbox (development builds). Default `off`: a sandbox token gets 503 `unsupported_environment` |
| `FCM_SERVICE_ACCOUNT` | secret | the Firebase service-account JSON (`project_id`, `client_email`, `private_key`, `token_uri`) |
| `APP_TITLE` | var | notification title, default `Trina AX` |

If a platform has no credentials, it answers 503 `not_configured`.

## Deploying later (owner; not done yet)

Worker:

1. `bunx wrangler kv namespace create BLOCKED`, then put the id in `wrangler.toml`.
2. `bunx wrangler secret put APNS_PRIVATE_KEY -c push-gateway/wrangler.toml`. Do the same for `APNS_KEY_ID` and
   `FCM_SERVICE_ACCOUNT`.
3. Uncomment `routes` and set the custom domain (for example `push.<your domain>`). Then
   `bunx wrangler deploy -c push-gateway/wrangler.toml`. The first deploy creates the `PushLimiter` Durable Object
   (migration `v1`).
4. Check that APNs works from the Worker (see above). If it does not, use the Bun entry for iOS.
5. To block a team key: `bunx wrangler kv key put --binding BLOCKED <key id> abuse -c push-gateway/wrangler.toml`. The
   block takes effect within about 60 s (edge cache).

Bun entry (a small server behind TLS: a reverse proxy or a Cloudflare tunnel):

```sh
APNS_KEY_ID=… APNS_TEAM_ID=… APNS_TOPIC=… APNS_PRIVATE_KEY_FILE=/etc/push-gateway/apns.p8 \
FCM_SERVICE_ACCOUNT_FILE=/etc/push-gateway/fcm.json PUSH_GATEWAY_DB=/var/lib/push-gateway/state.sqlite \
  bun push-gateway/src/bun.ts                              # listens on 127.0.0.1:8787 (PUSH_GATEWAY_HOST / _PORT)
bun push-gateway/src/bun.ts key-id <base64 SPKI key>       # a team's key id
bun push-gateway/src/bun.ts block <key id>                 # 403 from now on; unblock <key id> takes it back
```
