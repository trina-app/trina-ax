# push-gateway

Team servers call this service to send a native push to the iOS/Android app. Only the gateway holds the Apple (APNs)
and Google (FCM) credentials. It talks to APNs (over HTTP/2) and FCM HTTP v1 directly; it does not use the Expo push
service. It runs on Bun with its state in one SQLite file, behind a TLS terminator.

- Contract: [`shared/src/cloud-protocol/push-gateway.ts`](../shared/src/cloud-protocol/push-gateway.ts) (MIT, no
  imports). `POST /v1/send` takes a JSON body signed with the team's Ed25519 key (`Authorization: MycelPush …`).
  `GET /health` answers `{"ok":true}`. Every other path answers 404.
- Identity and trust: a team is its public key; the key id is the sha256 hex of the SPKI DER. Trust on first use: the
  gateway records a new key with its first-seen time. If nothing is delivered for that key within 24 h, the record is
  forgotten, so random keys cannot fill the state. An operator can block a key (403).
- Limits (`src/state.ts`, `LIMITS`):
  - per client address: 600 send requests a minute, counted before the signature is checked. An IPv6 address counts by
    its /64. These counters live in memory only.
  - per key: 120 a minute while the key is young (first seen less than 24 h ago), then 1200 a minute.
  - per (key, token) pair: 20 a minute and 200 a day (UTC), so one team server cannot use up a phone's budget for
    other teams.
  - dedupe: the same (key, token, notificationId) within 10 minutes is answered 200 without sending again. This is also
    the replay guard inside the ±5 minute timestamp window.
  - A refused or failed send is not remembered, so a retry sends.
- Notification content: there is no message content (App Review 4.5.4). The title is `APP_TITLE`; the body is a
  generic line picked from `code` and `locale` (`src/text.ts`).
- Data the app reads:
  - iOS: the APNs payload is `{aps:{alert,sound}, body:{notificationId, code, path?, device?}}`. expo-notifications reads
    remote data from `userInfo["body"]`. A room code (`room.*`) also gets `aps.mutable-content: 1`: the app's
    notification service extension (1.0.1 and later) may ask its own team server for who and where and put that in the
    title. The gateway never sees a name; the generic alert stays as the fallback (an app without the extension, or an
    extension that gets no answer, shows it).
  - Android: FCM `data` is the same keys as flat strings, and never a key named `body` or `tag` (expo-notifications uses
    `data.tag` as the notification id, so the request's `tag` travels as `device`).
- Logs: only `{evt, outcome, platform, status}`. Tokens, bodies, keys, signatures, client addresses and provider
  answers are never logged.

This is not a Cloudflare Worker because APNs accepts only HTTP/2. Cloudflare's only statement on a Worker's outbound
HTTP version is its
[2019 changelog](https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/): "Cloudflare
communicates with origin servers using HTTP/1.1".

## Tests and typecheck

```sh
bun test tests/unit/push-gateway*.test.ts
bunx tsc -p push-gateway/tsconfig.json --noEmit
```

The tests use fake APNs, FCM and OAuth endpoints (an injected `fetch`, plus a local HTTP/2 server). Their keys are
generated at runtime.

## Environment

| Name | What |
|---|---|
| `APNS_PRIVATE_KEY` (or `APNS_PRIVATE_KEY_FILE`) | secret: the `.p8` key (PKCS#8 PEM) |
| `APNS_KEY_ID` | the `.p8` key's id |
| `APNS_TEAM_ID`, `APNS_TOPIC` | Apple team id and the app's bundle id (`YWW96288YY`, `app.trina.ax`) |
| `APNS_SANDBOX` | `on` also sends to the APNs sandbox (development builds). Default off: a sandbox token gets 503 `unsupported_environment` |
| `FCM_SERVICE_ACCOUNT` (or `FCM_SERVICE_ACCOUNT_FILE`) | secret: the Firebase service-account JSON |
| `TRUST_PROXY_HEADER` | the header the TLS proxy sets to the client address, for example `x-forwarded-for` (the right-most entry is used) or `cf-connecting-ip`. Unset: the socket address |
| `PUSH_GATEWAY_DB` | SQLite file, default `./push-gateway.sqlite` |
| `PUSH_GATEWAY_HOST`, `PUSH_GATEWAY_PORT` | listen address, default `127.0.0.1:8787` |
| `APP_TITLE` | notification title, default `Trina AX` |

If a platform has no credentials, it answers 503 `not_configured`.

## Running it (owner; not deployed yet)

1. Build one file: `bun build push-gateway/src/bun.ts --target bun --outfile /opt/push-gateway/push-gateway.js`.
2. Put the secrets in files readable only by the service user, for example `/etc/push-gateway/apns.p8` and
   `/etc/push-gateway/fcm.json`. Put the rest in `/etc/push-gateway/env`:
   ```sh
   APNS_KEY_ID=…
   APNS_TEAM_ID=YWW96288YY
   APNS_TOPIC=app.trina.ax
   APNS_PRIVATE_KEY_FILE=/etc/push-gateway/apns.p8
   FCM_SERVICE_ACCOUNT_FILE=/etc/push-gateway/fcm.json
   TRUST_PROXY_HEADER=x-forwarded-for
   PUSH_GATEWAY_DB=/var/lib/push-gateway/state.sqlite
   ```
3. Add a systemd unit, `/etc/systemd/system/push-gateway.service`:
   ```ini
   [Unit]
   Description=push gateway
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=push-gateway
   EnvironmentFile=/etc/push-gateway/env
   ExecStart=/usr/local/bin/bun /opt/push-gateway/push-gateway.js
   StateDirectory=push-gateway
   Restart=on-failure
   NoNewPrivileges=yes
   ProtectSystem=strict
   ProtectHome=yes
   PrivateTmp=yes

   [Install]
   WantedBy=multi-user.target
   ```
4. Put TLS in front with Caddy (`/etc/caddy/Caddyfile`). Caddy replaces the `X-Forwarded-For` a client sends with the
   address it saw:
   ```
   push.trina.app {
     reverse_proxy 127.0.0.1:8787
   }
   ```
   Point the `push.trina.app` DNS record at the server and allow only ports 443 and 80.
5. To block a team key, run
   `PUSH_GATEWAY_DB=/var/lib/push-gateway/state.sqlite bun /opt/push-gateway/push-gateway.js block <key id>`. It takes
   effect on the next request; `unblock <key id>` undoes it.
   - Get a team's key id with `… push-gateway.js key-id <base64 public key>`.
   - Or block with SQL:
     `sqlite3 state.sqlite "INSERT INTO blocked (key_id, at) VALUES ('<key id>', strftime('%s','now')*1000)"`.
