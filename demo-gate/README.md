# demo-gate

The free-roam demo's front door (plan: `docs/AGENTS/plan/20261119-1534-demo-free-roam-gate.md`). A visitor who
finished the scripted demo opens `https://demo.trina.app/?lang=<en|ko>`, passes Turnstile and presses **Start**. The
gate gives them a private, warm copy of the demo team, signs them in as the new hire and proxies their browser to it.
The gate is also the copies' model upstream and holds the only real AI credential.

Runs on **Node 24+** (production: the relay's pinned Node 26), no dependencies. It listens on loopback only; a
Cloudflare named tunnel delivers `demo.trina.app` to the public port. Hosting (role users, pf egress rules, the
LaunchDaemon, the tunnel) is private ops and not in this repository.

## Run

```sh
node demo-gate/src/main.ts --config /var/demo-gate/gate.json     # or DEMO_GATE_CONFIG=/var/demo-gate/gate.json
bun run test:demo-gate                                          # the suite (needs node 24+ on PATH)
touch /var/demo-gate/PAUSE                                      # kill switch: no starts, model requests stopped
rm /var/demo-gate/PAUSE                                         # back on (read within a second)
curl -s http://127.0.0.1:19190/__demo/health                     # on the host only
```

Settings: [`gate.example.json`](gate.example.json). Relative paths are read from the file's folder. The two secrets
are files, never values in the config: `turnstile.secretFile` and `ai.credentialFile` must be mode 600 (the gate
refuses to start otherwise) and are read again when they change.

| setting | default | |
|---|---|---|
| `publicOrigin` | `https://demo.trina.app` | the instances' only public origin; the persona sign-in's `Origin` |
| `listen`, `upstreamListen` | 127.0.0.1:19190, :19191 | public port (the tunnel), model upstream port (the instances); loopback only |
| `ai.mode` | `claude-subscription` | ONE switch: `claude-subscription` sends `Authorization: Bearer` + the oauth beta; `anthropic-api-key` sends `x-api-key` and drops the oauth beta |
| `ai.upstream` | `https://api.anthropic.com` | https only (plain http to this machine for tests) |
| `pool.snapshotsDir` | | `<locale>/<name>/manifest.json` + `base/` (below) |
| `pool.instancesDir` | | clones go here; at most 31 bytes long, so the servers' unix sockets stay under 104 bytes |
| `pool.codeVersion` | | a snapshot whose manifest names another version is refused |
| `pool.command` | | the instance's argv; `{config}`, `{dir}`, `{port}`, `{proxyPort}` are filled in. Name `{config}` or `{dir}` in it: the sweeper only kills an orphan whose command line holds its folder |
| `pool.cloneCommand` | `cp -c -R` (macOS, APFS clone), `cp -R` elsewhere | argv before `<snapshot base> <instance dir>` |
| `pool.warmPerLocale`, `pool.maxLive`, `pool.ttlHours` | 2, 10, 24 | |
| `pool.env`, `pool.path` | `{}`, `/usr/bin:/bin:/usr/sbin:/sbin` | the instance env is built from scratch: these plus HOME/TMPDIR (inside the clone), `MYCEL_CONFIG`, `MYCEL_PUBLIC_ORIGINS`, `MYCEL_SPEECH_PREFETCH=0`, `MYCEL_RELAY_URL=''`, `MYCEL_PUSH_GATEWAY=off`, `MYCEL_DEMO` |
| `limits.startsPerHour`, `startsPerDay`, `livePerIp` | 3, 6, 2 | per visitor address (IPv6: per /64), from `CF-Connecting-IP` on a loopback peer |
| `limits.maxStreams`, `streamWaitMs` | 4, 30000 | model requests at once; a request that waits longer gets the neutral answer |
| `limits.dailyWeightedTokens` | 30 000 000 | global cap per UTC day |
| `links.*` | ax.trina.app/demo, /pricing | the busy page's buttons; `statusOrigins` may read `/__demo/status` (CORS) |

### Snapshots

```
<snapshotsDir>/en/20261119-0300/manifest.json   {"codeVersion":"0.5.21","locale":"en","createdAt":"…","config":"config/server.json","demoFile":"demo.json"}
<snapshotsDir>/en/20261119-0300/base/            the WHOLE base folder: config/, data/, secrets/, team/ …
```

The newest snapshot of a locale with the configured code version is cloned. The gate rewrites the clone's server.json
(mode 600): `listen` (127.0.0.1, own port), `engine.proxyPort` (own port), `engine.modelUpstreams.anthropic` =
`http://127.0.0.1:<upstream port>/i/<id>.<secret>` (`modelUpstream` and `anthropicGateway` removed), `publicOrigins`,
no relay, no update feed, no push gateway, no tunnel / TLS / tailnet listener. Snapshots older than the one in use are
removed by the sweeper (once they are an hour old).

## Paths

| path | |
|---|---|
| `GET /` | the visitor's instance (by the `__Host-tdg` cookie), else landing, busy (full or paused) or "session ended" |
| `POST /__demo/start` | form `lang`, `cf-turnstile-response`; our Origin only; limits, Turnstile, a warm instance, `POST /api/demo/persona {key:"newHire"}` on it (server to server, `Origin: <publicOrigin>`), its Set-Cookie with Secure forced, 303 to `/` |
| `POST /__demo/resume` | our Origin only; a visitor with a live instance (by the gate cookie) is signed in as the new hire again on that instance, the same persona call as start, 303 to `/`. "Continue as Mina" after signing out: sign-in with a password is fenced in the demo, so this is the only way back |
| `GET /__demo/status` | `{available}` for the scripted demo's button |
| `GET /__demo/health` | pool, live, streams, daily tokens, snapshot age, upstream state; loopback peers without the tunnel's client IP header only |
| everything else | proxied to the visitor's instance (HTTP and WebSocket); refused first: `/api/admin*`, `/api/setup*`, `/api/credential*`, `/api/me/credential*`, invites, guest invites, team links, password resets, `/api/auth/password`, `/api/demo/persona`, integration OAuth callbacks, `/oauth*`, `/mcp`, `/connector-uploads`, and the web pages `/invite`, `/join`, `/reset-password`, `/setup` |

## The model upstream

`POST /i/<id>.<secret>/v1/messages` and `/v1/messages/count_tokens` only (query `beta=true` at most). The path secret
is checked in constant time; the instance's dummy credential is dropped and the real one put on. Request headers:
anthropic-version, anthropic-beta, content-type, accept, user-agent, x-app. Response headers: `content-type` and
`cache-control` only. The `anthropic-ratelimit-unified-*` headers are read here (a `rejected` window or a 429 pauses
calls until the reset, at most an hour) and never passed on.

| upstream answer | the instance gets |
|---|---|
| 2xx | as it came (headers: allowlist); usage counted from `message_start` / `message_delta` (or the JSON body) |
| 400 `invalid_request_error` "prompt is too long" | passed through (status and body), so the engine compacts or starts fresh |
| daily cap reached, or PAUSE | 403 `{"type":"error","error":{"type":"permission_error","message":"budget_exceeded"}}` (the product proxy's budget stop) |
| any other non-2xx, an unreachable upstream, no free stream, an `error` event inside a stream | 503 `{"type":"error","error":{"type":"api_error","message":"The demo is busy, try again in a bit."}}` with `x-should-retry: false` (in a stream: the same object as an `error` event) |

Why that neutral shape, from the instance's own code: a 401 would make its model proxy mark the AI connection
refused (`broker.onUnauthorized`); a 400/402/403 with a request-id from a loopback upstream is read as Anthropic's
account refusal (`server/src/proxy/anthropic-refusal.ts`), so no gate answer carries a request-id; a 429 with a long
retry-after marks the connection limited, and 529 or `overloaded_error` make Claude Code retry for minutes. A 503 goes
through the instance's proxy unchanged and the engine's error text classifies as a `crash`
(`server/src/engine/claude-parse.ts`): the turn tries once more and then asks the person to try again. Nothing is
marked. The test suite checks this against the server's own functions.

Weight per request: uncached input + cache writes + output + 0.1 × cache reads. The gate keeps the global daily sum
(stateDir/state.json, with the start times per address as keyed hashes); the 300 000-token cap per visitor is kept
inside each instance (its block budget).

## Logs

JSON lines on stdout: instance ids, statuses, counts, times. Never a prompt, body, header, cookie, credential or path
secret; a visitor address only as an 8-character keyed hash. Each instance's own output goes to
`<instance dir>/.gate-instance.log` and is deleted with the clone.

## Limits of v1

- Visitor routing is in memory: a gate restart ends every session (the sweeper then removes the orphans).
- The gate's budget stop is the product's 403 shape, but the instance's turn gets no "budget" event for it (only the
  instance's own proxy sends that); it shows its generic failure.
