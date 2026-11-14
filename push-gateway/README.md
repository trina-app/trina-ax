# push-gateway

Team servers call this service to send a native push to the iOS/Android app. Only the gateway holds the Apple (APNs)
and Google (FCM) credentials. It talks to APNs (over HTTP/2) and FCM HTTP v1 directly; it does not use the Expo push
service. It runs on Bun with its state in one SQLite file, behind a TLS terminator.

- Who uses it: Trina team servers send through `https://push.trina.app` by default (installed servers and office
  Macs; the edition's `pushGatewayUrl` in `editions/trina/branding/service.json`), so self-hosted teams with the store
  app get phone pushes without a setting. An operator opts out with `MYCEL_PUSH_GATEWAY=off` (or `''`), or with
  `push.gatewayUrl` `null` / `"off"` in server.json; another `https://<host>` sends through a gateway of their own. The
  neutral core has no default. Decision: docs/DECISIONS.md "Trina team servers use push.trina.app by default".
- Without either setting, an owner or admin chooses in Settings › Notifications › Phone: the default, off, or Custom
  (an address of the team's own gateway, for their own build of the app). Custom is saved only when `GET /health` at
  that address answers `{"ok":true}`. The operator's variable or server.json wins and locks that choice. Decision:
  docs/DECISIONS.md "Owners and admins choose where phone notifications go".

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
- Time limits: an FCM send (the OAuth token call and the send call together) ends after 8 s (`FCM_TIMEOUT_MS`); an APNs
  call ends after 15 s with no data. A team server tries a failed push again 30 s or more later, so a stalled FCM call
  has ended as 502 and released its dedupe entry before the retry comes, and the retry sends.
- Notification content: there is no message content (App Review 4.5.4). The title is `APP_TITLE`; the body is a
  generic line picked from `code` and `locale` (`src/text.ts`).
- Data the app reads:
  - iOS: the APNs payload is `{aps:{alert,sound,badge?}, body:{notificationId, code, path?, device?}}`. expo-notifications reads
    remote data from `userInfo["body"]`. A room code (`room.*`) also gets `aps.mutable-content: 1`: the app's
    notification service extension (1.0.1 and later) may ask its own team server for who and where and put that in the
    title. The gateway never sees a name; the generic alert stays as the fallback (an app without the extension, or an
    extension that gets no answer, shows it).
  - Android: FCM `data` is the same keys as flat strings, and never a key named `body` or `tag` (expo-notifications uses
    `data.tag` as the notification id, so the request's `tag` travels as `device`).
- The app icon's number: the request's optional `badge` (a whole number 0 to 9999, the recipient's count of things that
  need them, computed by the team server) becomes `aps.badge` on iOS (0 clears the icon). Android gets none: its launchers count the
  notifications in the tray and add up their `notification_count`, so a total on each push would be counted again and
  again; each notification counts as one there. A number only. A gateway from before the field answers `400 invalid_body` to a
  request that has it; the team server then sends the same push without it and tries the field again an hour later.
- Logs: only `{evt, outcome, platform, status}`. Tokens, bodies, keys, signatures, client addresses and provider
  answers are never logged.

This is not a Cloudflare Worker because APNs accepts only HTTP/2. Cloudflare's only statement on a Worker's outbound
HTTP version is its
[2019 changelog](https://developers.cloudflare.com/workers/platform/changelog/historical-changelog/): "Cloudflare
communicates with origin servers using HTTP/1.1".

## State on disk

One SQLite file (`PUSH_GATEWAY_DB`) in WAL mode with `synchronous = NORMAL`: a write does not wait for the disk. With
SQLite's default (`FULL`) every one of a send's 4 to 5 writes waited for the disk on the only thread, and a load test
on the production server (2 vCPU, gp3 disk, fake providers) stopped at about 75 sends a second with the CPU idle. With
`NORMAL` it sent 400 a second (p99 279 ms). A power loss can drop the last few commits; they are rate-limit
counters, dedupe entries and first-seen records that expire within a day, so at worst a retry sends once more. A
crash of the gateway process alone loses nothing.

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
| `PUSH_GATEWAY_SENTRY_DSN` | error reports to the operators' Sentry project (below). Empty: off |
| `PUSH_GATEWAY_SENTRY_ENV` | the environment name on reports, default `production` |

If a platform has no credentials, it answers 503 `not_configured`.

## Error reports

Off until `PUSH_GATEWAY_SENTRY_DSN` is set (the Sentry project's DSN, in `/etc/push-gateway/env`; restart the service).
Built by `src/report.ts` with `shared/src/sentry-report.ts`, the same rules as the relay and the team server.

Reported:

- **Our credentials refused**, an event `CredentialRejected` with the tags `provider` (`apns`, `fcm`) and `reason`:
  APNs `InvalidProviderToken`, `ExpiredProviderToken` (for a token signed just now), `MissingProviderToken`,
  `BadCertificate`, `BadCertificateEnvironment`, `TopicDisallowed`, `BadTopic`, `MissingTopic`, `Forbidden`, a 403
  without a reason (`http_403`), a `.p8` key that cannot be read (`key_unreadable`); FCM `UNAUTHENTICATED`,
  `PERMISSION_DENIED`, `THIRD_PARTY_AUTH_ERROR`, a 401/403 without a code, the OAuth token call refused
  (`oauth_400`, `oauth_401`, …), a key that cannot be read, a service-account JSON that is set but cannot be read at
  start (`service_account_invalid`). Every send fails the same way then, so one event an hour is sent per reason.
- **A send that threw** (answered 500 `internal`): its type, scrubbed message and stack frames.
- **A crash**: then the process exits with 1 as before.

Not reported: a dead or wrong device token (APNs 410, `Unregistered`, `BadDeviceToken`; FCM `UNREGISTERED`, an invalid
registration token, `SENDER_ID_MISMATCH`). That is one phone; the team server deletes the device on the 410. Neither are
Apple's or Google's own outages (5xx, 429), which stay `provider_error` log lines.

Never in a report: device tokens, payloads, notification text, team keys or key ids, client addresses, the APNs or FCM
keys, provider answers. Tags: `release` = `push-gateway@<first 12 hex of the running file's sha256>`, `environment`.

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
   # error reports (below); empty = off
   PUSH_GATEWAY_SENTRY_DSN=
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
