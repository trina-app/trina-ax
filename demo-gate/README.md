# demo-gate

The free-roam demo's front door (plan: `docs/AGENTS/plan/20261119-1534-demo-free-roam-gate.md`). A visitor who
finished the scripted demo opens `https://demo.trina.app/?lang=<en|ko>`, passes Turnstile and presses **Start**. The
gate gives them a private, warm copy of the demo team, signs them in as the new hire and proxies their browser to it.
The gate is also the copies' model upstream and holds the only real AI credential.

Runs on **Node 24+** (production: the relay's pinned Node 26), no dependencies. It listens on loopback only; a
Cloudflare named tunnel delivers `demo.trina.app` to the public port. Hosting on a Mac (pf egress rules, the
LaunchDaemon, the tunnel) is private ops and not in this repository; hosting on Linux is ("Hosting on Linux" below). The
two users below are what the gate itself checks.

## Hosting users

The gate and the instances run as **two different users**. The gate's user can read the AI credential (mode 600);
an instance (a visitor's own server, whose AI and converters run visitor-chosen work) must not. The gate refuses to
start when `pool.runAs` is missing or is its own uid (`allowSameUser: true` is for the tests and development only).

| | owns | mode |
|---|---|---|
| gate user, e.g. `_demogate` | `/var/demo-gate` (config, `state/`, `secrets/`, `snapshots/`) | 700 for `state/` and `secrets/`, 600 for the secret files |
| instance user, e.g. `_demoinst` | `pool.instancesDir` (e.g. `/private/tmp/tdg`) | 750, group = the gate user's group, so the gate can list it but not write it |

- The snapshots stay the gate user's, readable by the instance user through a group both are in (the instance user
  clones them). The builder writes its files 600, so before a snapshot is moved in:
  `chgrp -R <shared group> <snapshot> && chmod -R g+rX <snapshot>`. Never that group on `secrets/` or `state/`.
- `pool.runAs: { "uid": <instance uid>, "gid": <instance gid> }`. As root the gate starts instances with that uid and
  gid. Otherwise (recommended: the gate is not root) every touch of an instance (clone, its config, start, signals,
  `du`, removal) runs as `sudo -n -u #<uid> -g #<gid> -- …`. The sudoers line, for that one target user only:
  `_demogate ALL=(_demoinst:_demoinst) NOPASSWD: ALL` (sudo is `pool.sudo`, default `/usr/bin/sudo`).
- The instance user's Claude Code binary is on `pool.path`; its home is the clone (`HOME` is set per instance).
- Each instance's process groups are kept in `state/instances/<id>.json` and its output in `state/logs/<id>.log`
  (gate-owned, so an instance cannot write either), removed with the instance.
- Defence in depth on the instance: its converter sandbox never reads `/private/var/demo-gate` nor the gate's state
  and secret folders (the gate passes them as `MYCEL_DEMO_GATE_DIRS`; `server/src/tools/isolate.ts`). The engine
  sandbox (`scripts/macos/engine.sb`) is deny-by-default and opens none of them.

## Hosting on Linux

[`gate.example.linux.json`](gate.example.linux.json) and [`linux/`](linux/) set the gate up on an amd64 Linux host
(built on Ubuntu 26.04, 28 GB of memory: 30 visitors at once). Everything is the demo's own: five system users, one
nft table, a few units and one sudoers file; no other service, user or firewall table is changed.

| user | runs | may reach (nft `inet trina_demo`, by socket uid) |
|---|---|---|
| `tdgate` | the gate (`trina-demo-gate.service`) | 127.0.0.1:19200–19399 (instances), the DNS stub 127.0.0.53, Anthropic's API ranges :443, Turnstile siteverify :443 |
| `tdrun` | the instances (through sudo, in the gate's cgroup) | 127.0.0.1:19191 (the gate's model upstream) and 19200–19399; nothing else, no DNS |
| `tdtunnel` | cloudflared (`trina-demo-tunnel.service`) | 127.0.0.1:19190, the DNS stub, the Cloudflare edge :443/:7844 |
| `tdbuild` | the nightly snapshot builder | loopback only |
| `tdcred` | the Claude Code login the gate uses | not restricted (it runs Claude Code only) |

Answers on allowed connections pass (`ct state established`); everything else from these users is rejected, the LAN,
Tailscale (100.64/10) and every local service (Postgres and others) included. Each instance takes three ports of
`pool.portRange` (its listener, its model proxy and the proxy's internal server, `engine.proxyInnerPort`), so the
instance user needs no ephemeral loopback ports (the Mac pf rules still allow them).

- **Instances on XFS with reflink.** `/srv/tdg` is an XFS file system on a loop image (`/var/lib/trina-demo/tdg.xfs`,
  60 GB, sparse, in fstab) made with `-m reflink=1`. The snapshots (`/srv/tdg/.snapshots`) and the builder's output
  (`/srv/tdg/.build`) are on it too: `cp --reflink=always -R` (`pool.cloneCommand`) clones a snapshot without copying
  it, and a new snapshot moves in by rename. The sweeper only removes 8-hex folders there.
- **Memory.** The instances stay in the gate unit's cgroup: `MemoryHigh=16G`, `MemoryMax=18G` hold all of them
  together. Each instance runs under `choom -n 800` (`pool.command`), so when memory runs out the kernel ends an
  instance, not the gate or another service.
- **The unit.** `ProtectHome=yes` (no instance sees `/home` or `/root`), `ProtectSystem=full`, `PrivateTmp=yes`. Not
  `NoNewPrivileges` (the gate uses sudo), and not `ProtectKernelTunables`, `ProtectProc` or `ProtectControlGroups`:
  they mount over `/proc` and `/sys`, and the converters' bwrap then cannot mount its own `/proc`.
- **bwrap.** The converters' isolation (`server/src/tools/isolate.ts`) needs bwrap to make user namespaces. Ubuntu
  24.04+ restricts them (`kernel.apparmor_restrict_unprivileged_userns=1`); its AppArmor profile for `/usr/bin/bwrap`
  (`bwrap-userns-restrict`, or a host's own replacement) allows bwrap and nothing else. `install.sh` checks bwrap as
  `tdrun` and stops when it fails; never turn the restriction off system-wide for the demo.
- **The engine has no OS sandbox of its own on Linux.** A dev-mode server (every instance) runs Claude Code under
  macOS's `engine.sb` only (`server/src/context.ts` `devEngineSandbox`). On Linux the instances rely on Claude Code's
  tool lockdown (no Bash, no file tools: `server/src/engine/claude.ts`), the nft table and the unit's protections; all
  instances are one user.
- **Credential.** A person signs in once as `tdcred` (`sudo -u tdcred -H /opt/trina-demo/claude/bin/claude`, then
  `/login`). `trina-demo-credsync.timer` copies the access token into the gate's credential file every 5 minutes
  through `tdgate-set-credential` (the one command `tdcred` may run as `tdgate`), and lets Claude Code renew the login
  when less than 20 minutes are left. Never copy a token from another machine.
- **Tunnel.** One named tunnel per host, created for it, with one connector. **Never add a second connector to a tunnel
  that serves the live hostname from another machine**: Cloudflare spreads requests over connectors, and a visitor's
  next request would reach a gate that does not know their instance ("session ended"). To move the live hostname,
  point its DNS record at the new host's tunnel once that host answers on its own staging hostname.

Install (the operator; `STAGE` is any empty folder the operator owns):

```sh
git archive <sha> | tar -x -C STAGE/app                      # the app source (on the host: STAGE/app)
sh STAGE/app/demo-gate/linux/stage.sh STAGE                  # no root: pinned downloads (pins.env, packages.json), app build
# optional, mode 600: STAGE/secrets/{turnstile-secret, canary-sealed, tunnel-creds.json, tunnel-id, tunnel-hostname}
sudo sh STAGE/app/demo-gate/linux/install.sh --stage STAGE --origin https://demo.example --site-key <turnstile site key>
```

`install.sh` is idempotent (run it again after a new stage to update the app; `gate.json` is kept, its
`pool.codeVersion` follows the app). It installs only missing packages (`xfsprogs`, `libheif-examples`), puts the
programs in `/opt/trina-demo`, the state in `/var/demo-gate` (700), checks reflink and bwrap as `tdrun`, builds the
first snapshots and starts the gate and the tunnel. Until the `tdcred` login the credential is a placeholder and every
AI answer is "busy".

| unit | |
|---|---|
| `trina-demo-gate.service` | the gate (ExecStartPre loads the nft table as root: never a gate without it) |
| `trina-demo-tunnel.service` | cloudflared, `/var/demo-tunnel/config.yml` |
| `trina-demo-nft.timer` | `tdnft-load` every 10 minutes: the table when it is missing or changed, Turnstile's addresses |
| `trina-demo-snapshots.timer` | `tdsnap-rebuild` at 05:00: build, canary scan, move in (`TD_LOCALES="en ko"` for some) |
| `trina-demo-credsync.timer` | `tdcred-credsync` every 5 minutes |

## Run

## Run

```sh
node demo-gate/src/main.ts --config /var/demo-gate/gate.json     # or DEMO_GATE_CONFIG=/var/demo-gate/gate.json
bun run test:demo-gate                                          # the suite (needs node 24+ on PATH)
touch /var/demo-gate/PAUSE                                      # kill switch: no starts, model requests stopped
rm /var/demo-gate/PAUSE                                         # back on (read within a second)
curl -s http://127.0.0.1:19190/__demo/health                     # on the host only
curl -s "http://127.0.0.1:19190/__demo/stats?days=30" | jq      # daily totals, on the host only
```

Settings: [`gate.example.json`](gate.example.json) (Linux: [`gate.example.linux.json`](gate.example.linux.json)). Relative paths are read from the file's folder. The two secrets
are files, never values in the config: `turnstile.secretFile` and `ai.credentialFile` must be mode 600 (the gate
refuses to start otherwise) and are read again when they change.

| setting | default | |
|---|---|---|
| `publicOrigin` | `https://demo.trina.app` | the instances' only public origin; the persona sign-in's `Origin` |
| `listen`, `upstreamListen` | 127.0.0.1:19190, :19191 | public port (the tunnel), model upstream port (the instances); loopback only |
| `ai.mode` | `claude-subscription` | ONE switch: `claude-subscription` sends `Authorization: Bearer` + the oauth beta; `anthropic-api-key` sends `x-api-key` and drops the oauth beta |
| `ai.upstream` | `https://api.anthropic.com` | https only (plain http to this machine for tests) |
| `ai.models`, `ai.defaultModel` | the Sonnet ids (`claude-sonnet-5-5`, `-5`, `-4-6`, `-4-5`) and the small Haiku ids Claude Code uses for side calls (`claude-haiku-5-5`, `-4-5`); `claude-sonnet-5-5` | the model pin: a request whose `model` is not one of these (or one with a `-YYYYMMDD` date) is sent with `defaultModel` instead, so an Opus request costs Sonnet and still answers (a refusal would read as "busy" on every try) |
| `pool.runAs`, `pool.allowSameUser`, `pool.sudo` | required, false, `/usr/bin/sudo` | the instance user (above); same user only for tests |
| `pool.snapshotsDir` | | `<locale>/<name>/manifest.json` + `base/` (below) |
| `pool.instancesDir` | | clones go here; at most 31 bytes long, so the servers' unix sockets stay under 104 bytes |
| `pool.codeVersion` | | a snapshot whose manifest names another version is refused |
| `pool.command` | | the instance's argv (Linux: under `choom -n 800 --`); `{config}`, `{dir}`, `{port}`, `{proxyPort}` are filled in. It must name `{config}` or `{dir}` (refused at load otherwise): a recorded process group is only killed while a member's command line holds its folder, never a group whose number was reused |
| `pool.diskCapMB` | 1024 | the sweeper measures each instance folder (`du -sk`, 20 s limit, as the instance user); over the cap the instance ends and its visitor sees "session ended" |
| `pool.cloneCommand` | `cp -c -R` (macOS, APFS clone), `cp -R` elsewhere | argv before `<snapshot base> <instance dir>`; Linux on XFS with reflink: `cp --reflink=always -R` |
| `pool.warmPerLocale`, `pool.maxLive`, `pool.ttlHours` | 2, 10, 24 | |
| `pool.env`, `pool.path` | `{}`, `/usr/bin:/bin:/usr/sbin:/sbin` | the instance env is built from scratch: these plus HOME/TMPDIR (inside the clone), `MYCEL_CONFIG`, `MYCEL_PUBLIC_ORIGINS`, `MYCEL_SPEECH_PREFETCH=0`, `MYCEL_RELAY_URL=''`, `MYCEL_PUSH_GATEWAY=off`, `MYCEL_DEMO`. The server finds Claude Code (`claude`), `rg` and the document tools on this PATH only (HOME is the clone), so put the folder of the instance user's Claude Code binary on it; without it every chat fails |
| `limits.startsPerHour`, `startsPerDay`, `livePerIp` | 3, 6, 2 | per visitor address (IPv6: per /64), from `CF-Connecting-IP` on a loopback peer |
| `limits.exemptIpHashes`, `exemptLivePerIp` | `[]`, 6 | addresses that skip `startsPerHour` and `startsPerDay` (the office, shared by the owner and QA), and have `exemptLivePerIp` live copies at once instead of `livePerIp`. Each entry is the keyed hash the gate stores the address under in `stateDir/state.json` `starts` (HMAC-SHA256 with `stateDir/ip-key`, first 32 hex characters), or a prefix of it of at least 8 hex characters; never a raw address (refused at load). The daily token cap, the cap per instance, `maxLive` and Turnstile still apply. To get an address's hash on the gate host: `sudo node -e 'const c=require("node:crypto"),f=require("node:fs");console.log(c.createHmac("sha256",f.readFileSync(process.argv[1])).update(process.argv[2]).digest("hex").slice(0,32))' <stateDir>/ip-key <address>` (an IPv6 address as its /64, the way the gate counts it: `2001:0db8:0001:0002::/64`) |
| `limits.maxStreams`, `streamWaitMs` | 4, 30000 | model requests at once; a request that waits longer gets the neutral answer |
| `limits.streamsPerInstance` | 2 | model requests at once for one instance (one visitor), inside `maxStreams` |
| `limits.instanceCapMargin` | 1.2 | the gate's own cap per instance: its demo limit (GET /api/demo `cap`) × this, then 403 `budget_exceeded` |
| `limits.dailyWeightedTokens` | 30 000 000 | global cap per UTC day |
| `links.*` | ax.trina.app/demo, /pricing | the busy page's buttons; `statusOrigins` may read `/__demo/status` (CORS) |

### Snapshots

```
<snapshotsDir>/en/20261119-0300/manifest.json   {"codeVersion":"0.5.21","locale":"en","createdAt":"…","config":"config/server.json","demoFile":"demo.json"}
<snapshotsDir>/en/20261119-0300/base/            the WHOLE base folder: config/, data/, secrets/, team/ …
```

`demoFile` is required (a snapshot without it is skipped). Before an instance is warm the gate asks its `GET /api/demo`:
it must say `kind: "freeRoam"`, no `builder` and a `cap`. Otherwise the instance is ended and its snapshot is marked
bad (never cloned again by this gate; log `snapshot refused: not a fenced free-roam demo`).

The newest snapshot of a locale with the configured code version is cloned. The gate rewrites the clone's server.json
(mode 600): `listen` (127.0.0.1, own port), `engine.proxyPort` and `engine.proxyInnerPort` (own ports), `engine.modelUpstreams.anthropic` =
`http://127.0.0.1:<upstream port>/i/<id>.<secret>` (`modelUpstream` and `anthropicGateway` removed), `publicOrigins`,
no relay, no update feed, no push gateway, no tunnel / TLS / tailnet listener. Snapshots older than the one in use are
removed by the sweeper (once they are an hour old).

## Paths

| path | |
|---|---|
| `GET /` | the visitor's instance (by the `__Host-tdg` cookie), else landing, busy (full or paused) or "session ended" |
| `POST /__demo/start` | form `lang`, `cf-turnstile-response`; our Origin only; limits, Turnstile, a warm instance, `POST /api/demo/persona {key:"newHire"}` on it (server to server, `Origin: <publicOrigin>`), its Set-Cookie (`__Host-sid`) with Secure forced, no Domain and, for a `__Host-` cookie, Path=/, plus `mycel_locale=<lang>` and `Clear-Site-Data: "storage"` (exactly that: never `"cookies"`, which in Chrome clears all of trina.app), 303 to `/?fresh=1` (the web app clears the tab's own storage there: Safari ignores Clear-Site-Data on the redirect) |
| `POST /__demo/resume` | our Origin only; a visitor with a live instance (by the gate cookie) is signed in as the new hire again on that instance, the same persona call as start, 303 to `/`. "Continue as Mina" after signing out: sign-in with a password is fenced in the demo, so this is the only way back |
| `GET /__demo/status` | `{available}` for the scripted demo's button |
| `GET /__demo/health` | pool, live, streams, daily tokens, snapshot age, upstream state (with `upstream.limits`: the account's unified 5h/7d utilization as fractions, status, reset, seenAt); loopback peers without the tunnel's client IP header only |
| `GET /__demo/stats?days=30` | the daily totals (`stateDir/stats.json`, 0600, 400 days kept) per UTC day and locale (`en`, `ko`, `-` when unknown): `landing`, `busyShown`, `refusedPaused`, `refusedFull`, `refusedLimit`, `turnstilePass`, `turnstileFail`, `starts`, `startFailed`, `resumes`, `questions` (a 2xx `POST /api/chats/:id/messages`), `hitLimit` (once per visitor, at the instance's own demo limit), `startFree`, `tokens` (weighted) and time active (last request or WebSocket close minus start) as `dur.lt2m`, `dur.2to10m`, `dur.10to30m`, `dur.30to60m`, `dur.60mPlus`; plus `distinctStarters24h` (the count of the start limits' keyed hashes). **No visitor ids**: counters only, never an address, hash or cookie. Same check as health |
| `GET /__demo/go/start-free` | the free-roam app's "Start free" button (the demo file's `signupUrl`, `scripts/demo/steepling/make.ts`): counts `startFree` with the visitor's locale, 302 to `links.pricing` |
| everything else | proxied to the visitor's instance (HTTP and WebSocket); refused first: `/api/admin*`, `/api/setup*`, `/api/credential*`, `/api/me/credential*`, invites, guest invites, team links, password resets, `/api/auth/password`, `/api/demo/persona`, integration OAuth callbacks, `/oauth*`, `/mcp`, `/connector-uploads`, `/connector-downloads`, and the web pages `/invite`, `/join`, `/reset-password`, `/setup` |

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
| daily cap reached, the instance's own cap (demo limit × 1.2), or PAUSE | 403 `{"type":"error","error":{"type":"permission_error","message":"budget_exceeded"}}` (the product proxy's budget stop) |
| any other non-2xx, an unreachable upstream, no free stream, an `error` event inside a stream | 503 `{"type":"error","error":{"type":"api_error","message":"The demo is busy, try again in a bit."}}` with `x-should-retry: false` (in a stream: the same object as an `error` event) |

Why that neutral shape, from the instance's own code: a 401 would make its model proxy mark the AI connection
refused (`broker.onUnauthorized`); a 400/402/403 with a request-id from a loopback upstream is read as Anthropic's
account refusal (`server/src/proxy/anthropic-refusal.ts`), so no gate answer carries a request-id; a 429 with a long
retry-after marks the connection limited, and 529 or `overloaded_error` make Claude Code retry for minutes. A 503 goes
through the instance's proxy unchanged and the engine's error text classifies as a `crash`
(`server/src/engine/claude-parse.ts`): the turn tries once more and then asks the person to try again. Nothing is
marked. The test suite checks this against the server's own functions.

Weight per request: uncached input + cache writes + output + 0.1 × cache reads. The gate keeps the global daily sum
in that weight (stateDir/state.json, with the start times per address as keyed hashes). The 300 000-token cap per
visitor is kept inside each instance (its block budget), which counts cache writes at 0.1 too, so a fresh copy's system
prompt and tools written to the cache are not the visitor's first question. The gate holds each instance to that cap ×
`instanceCapMargin` in the instance's weight (`visitorWeighted`), in case the instance's own count went wrong. Each
`upstream usage` log line has both counts (`tokens` for the day, `visitor`) and the usage fields (`in`, `cw`, `cr`,
`out`).

## Logs

JSON lines on stdout: instance ids, statuses, counts, times. Never a prompt, body, header, cookie, credential or path
secret; a visitor address only as an 8-character keyed hash (IPv6 by its /64, written out in full, so every spelling
of one address is one visitor; IPv4-mapped addresses count as the IPv4 one). Each instance's own output goes to
`<stateDir>/logs/<id>.log` and is deleted with the instance.

## Limits of v1

- Visitor routing is in memory: a gate restart ends every session (the sweeper then removes the orphans).
- The gate's budget stop is the product's 403 shape, but the instance's turn gets no "budget" event for it (only the
  instance's own proxy sends that); it shows its generic failure.
