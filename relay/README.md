# relay

The Team AX relay (component F): gives every team server a public address `https://<team>.<domain>` without opening
ports. The team server keeps 2-4 outbound WebSockets to the relay (`wss://relay.<domain>/connect`); the relay
multiplexes browser HTTP requests, streams and WebSockets over them (protocol v2, `shared/src/relay-protocol`).
The relay stores nothing it forwards. Its log holds team ids, byte counts and times only; the real client IP goes to
the team server inside the stream's OPEN frame and nowhere else.

Runs on **Node 25** (`node:http` + `ws`): Bun.serve has no backpressure on streaming bodies (spike report).

## Run

```sh
bun run dev:relay              # http://<team>.localhost:19161, registry in .dev/relay, light proof of work
bun run dev:server:relay       # dev server that registers "myteam" and connects: http://myteam.localhost:19161
# or: MYCEL_RELAY_URL=ws://127.0.0.1:19161/connect MYCEL_RELAY_TEAM=acme bun run dev:server

node relay/src/main.ts --domain treesoop.com --port 8080 --data /var/lib/mycel-relay   # production (behind Cloudflare)
```

Production defaults: listens on `0.0.0.0:8080`, public scheme https, client IP from `CF-Connecting-IP` (the origin
firewall must accept Cloudflare addresses only), proof of work 20 bits. Settings (flag / env):

| flag | env | default | |
|---|---|---|---|
| `--domain` | `RELAY_DOMAIN` | `localhost` with `--dev` | team addresses are `<team>.<domain>` |
| `--port`, `--host` | `RELAY_PORT`, `RELAY_HOST` | 8080, 0.0.0.0 (dev 19161, 127.0.0.1) | |
| `--data` | `RELAY_DATA_DIR` | `/var/lib/mycel-relay` | registry.db (SQLite) |
| `--client-ip-header` | `RELAY_CLIENT_IP_HEADER` | `cf-connecting-ip` (none for localhost) | |
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

SIGTERM: stop accepting, GOAWAY(restart) to team servers (they reconnect at once), 1012 to browser WebSockets (they
resume), wait for running HTTP streams up to `RELAY_GRACE_MS`. On Linux the listener uses `reusePort`, so a new
process can start on the same port first.

## Operator commands

```sh
node relay/src/main.ts teams [--dev]          # list
node relay/src/main.ts suspend acme           # kill switch (visitors see "suspended", the team server gets 4010)
node relay/src/main.ts unsuspend acme
node relay/src/main.ts release acme           # reclaim; the name is held for a year
node relay/src/main.ts reserve somename | block somename
```

A running relay notices suspensions and key changes within 5 seconds.

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

`bun run test:unit` covers the codec (vectors + fuzzer), the multiplexer, the registry and relay + client in one
process. `bun run test:relay` runs the conformance suite against a real Node relay process and team-server
processes (head-of-line, slow readers, uploads, cancels, SIGSTOP, kill -9 / SIGTERM restarts, auth, instance
takeover, 1,000 idle sockets, browser floods) and the review's attack cases (`tests/relay/f-hardening.test.ts`). Design decisions: `docs/DECISIONS.md`, section "F 중계".
