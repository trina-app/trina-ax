# relay

The Trina AX relay (component F): gives every team server a public address `https://<team>.<domain>` without opening
ports. The team server keeps 2-4 outbound WebSockets to the relay (`wss://relay.<domain>/connect`); the relay
multiplexes browser HTTP requests, streams and WebSockets over them (protocol v2, `shared/src/relay-protocol`).
The relay stores nothing it forwards. Its log holds team ids, byte counts and times only; the real client IP goes to
the team server inside the stream's OPEN frame and nowhere else.

Runs on **Node 26 LTS** in production (24+ works; `node:http` + `ws`): Bun.serve has no backpressure on streaming
bodies (spike report). Deployment reference (operator-managed relay): [`deploy/README.md`](deploy/README.md).

## Run

```sh
bun run dev:relay              # http://<team>.localhost:19161, registry in .dev/relay, light proof of work
bun run dev:server:relay       # dev server that registers "myteam" and connects: http://myteam.localhost:19161
# or: MYCEL_RELAY_URL=ws://127.0.0.1:19161/connect MYCEL_RELAY_TEAM=acme bun run dev:server

node relay/src/main.ts --domain example.com --port 8080 --data /var/lib/mycel-relay   # behind Cloudflare / a tunnel
bun scripts/build-relay.ts     # production bundle dist/relay/teamax-relay-<v>.tar.zst (relay/deploy/relay-deploy.sh)
```

Production defaults: listens on `0.0.0.0:8080`, public scheme https, client IP from `CF-Connecting-IP`, proof of work
20 bits. The relay believes `CF-Connecting-IP` only from a socket peer inside `--trusted-proxies` (default: Cloudflare's
published ranges); anyone else who reaches the origin directly is identified by their socket address, whatever header
they send. Still keep the origin firewall to Cloudflare addresses only, and turn on Cloudflare Authenticated Origin
Pulls if the host allows it. Behind a local `cloudflared` tunnel the peer is loopback: run with
`--trusted-proxies 127.0.0.1,::1` (only when nothing else on that host can reach the port). Settings (flag / env):

| flag | env | default | |
|---|---|---|---|
| `--domain` | `RELAY_DOMAIN` | `localhost` with `--dev` | team addresses are `<team>.<domain>`; a comma list serves several domains (the first is the default) |
| `--port`, `--host` | `RELAY_PORT`, `RELAY_HOST` | 8080, 0.0.0.0 (dev 19161, 127.0.0.1) | |
| `--data` | `RELAY_DATA_DIR` | `/var/lib/mycel-relay` | registry.db (SQLite) |
| `--client-ip-header` | `RELAY_CLIENT_IP_HEADER` | `cf-connecting-ip` (none for localhost) | |
| `--trusted-proxies` | `RELAY_TRUSTED_PROXIES` | `cloudflare` | peers whose client IP header counts: CIDRs / addresses, comma separated; `cloudflare` = Cloudflare's ranges, `none` = nobody |
| `--pow-bits` | `RELAY_POW_BITS` | 20 (dev 8) | registration proof of work |
| | `RELAY_HOLD_MS` | 5000 | requests wait this long for a (re)connecting team |
| | `RELAY_SILENCE_MS` | 45000 | half-open control connection limit |
| | `RELAY_RESPONSE_TIMEOUT_MS` | 100000 | from the end of the request body to the response head |
| | `RELAY_BODY_IDLE_MS` | 60000 | a request body that stops arriving is aborted (408) |
| | `RELAY_STALL_MS`, `RELAY_PONG_TIMEOUT_MS` | 5000, 10000 | stall probe |
| | `RELAY_WINDOW` | 262144 | per-stream window |
| | `RELAY_CLIENT_WS_CAP` | 4194304 | browser WebSocket backlog cap (close 1009) |
| | `RELAY_RESERVED` | | extra reserved names, comma separated |
| | `RELAY_GRACE_MS` | 10000 | SIGTERM: time for running HTTP streams |
| `--open-registration` | `RELAY_OPEN_REGISTRATION` | 1 with `--dev`, else **0** | public self-registration with proof of work; 0 = only claim codes (and the operator API) |
| `--tls-cert`, `--tls-key` | `RELAY_TLS_CERT`, `RELAY_TLS_KEY` | | the relay terminates TLS (Cloudflare Origin CA certificate, PEM) |
| `--tls-client-ca` | `RELAY_TLS_CLIENT_CA` | | only TLS clients with a certificate from this CA (Authenticated Origin Pulls, zone certificate) |
| `--private-listen` | `RELAY_PRIVATE_LISTEN` | | `host:port` (Tailscale address): operator API `/ops/v1/*` and `/metrics` |
| `--operator-keys` | `RELAY_OPERATOR_KEYS_FILE` | | `operator-keys.json`: `[{ keyId, publicKey, label, scopes }]`, re-read when it changes |
| `--health-listen` | `RELAY_HEALTH_LISTEN` | | loopback `host:port` answering `/healthz` for THIS process (a/b deploy) |
| | `RELAY_HSTS` | 1 | `Strict-Transport-Security: max-age=31536000` on team answers without one (https addresses only) |
| | `RELAY_ACCOUNT_HOST`, `RELAY_STATUS_HOST` | account.treesoop.com, status.treesoop.com | named on the billing-suspension and cloud-offline pages |

SIGTERM: stop accepting, GOAWAY(restart) to team servers (they reconnect at once), 1012 to browser WebSockets (they
resume), wait for running HTTP streams up to `RELAY_GRACE_MS`. On Linux the listener uses `reusePort`, so a new
process can start on the same port first.

## Operator commands (on the relay host)

```sh
node relay/src/main.ts teams [--dev]          # list (status, suspension reason, origin self / cloud / addon)
node relay/src/main.ts suspend acme [--reason billing|canceled|abuse|security|operator]
node relay/src/main.ts unsuspend acme
node relay/src/main.ts release acme           # reclaim; the name is held for a year
node relay/src/main.ts reserve somename | block somename
node relay/src/main.ts create ax-probe --public-key K --sig S --ts T [--origin cloud] [--ref R]
node relay/src/main.ts claim clinic --ref <control plane team id> [--days 7]   # one-time claim code, shown once
node relay/src/main.ts maintenance acme 15    # "being updated" page while the team is offline (0 = off)
node relay/src/main.ts keys | audit           # operator keys, recent operator actions
```

A running relay notices suspensions and key changes within 5 seconds (at once through the operator API).

## Operator API (private listener only)

`RELAY_PRIVATE_LISTEN` (the relay's Tailscale address) serves `/ops/v1/*` and `/metrics`; the public listener answers 404
for both. Types, signing and validators: `shared/src/cloud-protocol/relay-ops.ts` (MIT). Every request carries
`Authorization: MycelRelayOps key=<keyId>, ts=<ms>, sig=<b64>`, an Ed25519 signature over
`mycel-relay-ops-v1\n<METHOD>\n<path?query>\n<ts>\n<sha256hex(body)>` by a key in `operator-keys.json`; the relay
refuses an unknown key, a clock off by more than 60 s or a bad signature (401), the same signature within 120 s (409
`replayed`; keep `ts` strictly increasing) and a key without the endpoint's scope (403). Writes are idempotent and
recorded in the registry's `ops_audit` (key id, action, team id).

| | | scope |
|---|---|---|
| `GET /ops/v1/names/:name` | can this address be had | teams:read |
| `POST /ops/v1/holds` `{ name, ttlSec ≤ 3600 }`, `DELETE /ops/v1/holds/:name` | hold an address during signup | teams:write |
| `POST /ops/v1/teams` `{ name, publicKey, ts, sig, region, origin, externalRef }` | a team with the tenant's own key, no proof of work (201; the same externalRef + key again: 200, the same team) | teams:write |
| `GET /ops/v1/teams/:id`, `GET /ops/v1/teams?origin=&cursor=` | `OperatorTeamInfo` (online, connections, last version, …) | teams:read |
| `POST …/:id/suspend` `{ reason }`, `POST …/:id/unsuspend` | billing / canceled show "check the payment"; others the plain page | teams:write |
| `POST …/:id/maintenance` `{ untilMs \| null }` | "being updated" (503, Retry-After 30) while offline | teams:write |
| `PUT …/:id/key`, `PATCH …/:id` `{ name }`, `DELETE …/:id` | key rotation, rename (old address: 308 for 90 days), release | teams:write |
| `POST …/:id/notice` `{ level, code, message }` | EVENT notice to the connected team server (409 when offline) | notice:write |
| `POST /ops/v1/claims` `{ name, ttlSec ≤ 7 d, externalRef }`, `DELETE /ops/v1/claims/:externalRef` | claim code for the self-hosted add-on (`POST /teams` with `claimCode`, no proof of work) | claims:write |
| `GET /ops/v1/stats` | counts | teams:read |

`/metrics` (Prometheus text): team counts, online teams, control connections, streams, browser sockets, request and
WebSocket outcomes, bytes, registrations by kind, operator API failures, event-loop p99, RSS. No team label anywhere.

## Registry API (on the relay's own address)

`GET /healthz`, `GET /teams/pow`, `POST /teams` (name + Ed25519 public key + signature + proof of work → team id and a
recovery code shown once), and signed (`Authorization: MycelRelay team=<id>, ts=<ms>, sig=<b64>`):
`GET /teams/:id`, `POST /teams/:id/heartbeat`, `PATCH /teams/:id` (rename / key rotation; the recovery code can
rotate a lost key), `DELETE /teams/:id`. Types: `shared/src/relay-protocol/registry-api.ts`.

## Limits a team server or a visitor can't get around

Requests a team server could not take (absolute-form or `*` targets, more than 256 headers, a head over 32 KB) get
400 from the relay. Control frames a peer makes the relay queue are capped (one pending PONG, 24 MB in all), team
WebSocket messages are passed on as fragments (never assembled), control connections accept 256 KB messages,
browser sockets 4 MB. Set-Cookie from team servers loses its `Domain` attribute: every team address shares the
parent domain, so a team server must not set cookies for the others (the app uses `__Host-` cookies anyway; a
dedicated team-address domain should go on the Public Suffix List).

## Tests

`bun run test:unit` covers the codec (and `f-registry-cloud`, `f-relay-ops`, `f-build-relay`: schema steps, operator
API, claim codes, cloud pages, the bundle) (vectors + fuzzer), the multiplexer, the registry and relay + client in one
process. `bun run test:relay` runs the conformance suite against a real Node relay process and team-server
processes (head-of-line, slow readers, uploads, cancels, SIGSTOP, kill -9 / SIGTERM restarts, auth, instance
takeover, 1,000 idle sockets, browser floods), the review's attack cases (`tests/relay/f-hardening.test.ts`) and the
cloud additions under Node (`tests/relay/f-cloud.test.ts`: TLS + client certificate, an old registry file, the operator
API with a team server process). Design decisions: `docs/DECISIONS.md`, section "F 중계".
