# Free-roam demo, PR D1: the demo gate service (`demo-gate/`)

- Date (UTC): 2026-11-19 15:34
- Branch: `feat/demo-free-roam-gate`
- Status: done (code and tests; not deployed: hosting is its own step)
- Where: `demo-gate/` (new standalone service, like `relay/`), `package.json` (test script), `.github/workflows/ci.yml`
  (one step next to the relay suite), `tsconfig.json` (include). Why: the gate is its own process in front of the
  per-visitor instances and holds the only real AI credential; no server code changes (PR A/B own `server/`).
- Version impact: none. The gate is not part of a server, desktop or phone release.

## Goal

A visitor who finished the scripted demo presses "Now try it yourself" and lands on demo.trina.app: a landing page with
Turnstile and Start. The gate hands them a warm, private copy of the demo team, signs them in as Mina and proxies the
browser to it. The gate is also the instances' model upstream: it swaps each instance's path secret for the one real
credential, counts weighted tokens for a global daily cap and turns every upstream failure into one neutral answer.

## Scope

In:
- Pages (en, ko): landing (Turnstile + Start), busy (full or paused: links to the scripted demo and pricing), session
  ended (Start again). `?lang=` wins over Accept-Language.
- `POST /__demo/start`: Turnstile (secret file), per-IP limits (3/hour, 6/day, 2 live), warm instance, visitor cookie
  (`__Host-tdg`, HttpOnly Secure SameSite=Lax), server-to-server `POST /api/demo/persona {key:"newHire"}` with
  `Origin: https://demo.trina.app`, its Set-Cookie relayed with Secure forced, 303 to `/`.
- Reverse proxy by visitor cookie (HTTP + WebSocket upgrade as a raw socket pipe), deny list (admin, setup,
  credentials, invites, team-link join, password resets, OAuth callbacks, `/mcp`, persona switching).
- Pool: clone the whole snapshot base folder (`cp -c -R` on macOS) into a short path (unix socket limit), per-instance
  server.json (ports, model upstream with path secret, public origin, no relay, no update feed, no push), an env built
  from scratch, a pluggable command, health check, 2 warm per locale, maxLive 10, 24 h expiry, sweeper (expired, dead,
  orphan folders and processes, old snapshots), snapshot manifest pinned to the configured code version.
- Model upstream on its own loopback port: `/i/<id>.<secret>/v1/messages` and `count_tokens` only, one setting for
  `claude-subscription` (Bearer + oauth beta) or `anthropic-api-key` (x-api-key, no oauth beta), response header
  allowlist, error rewrite, prompt-too-long passthrough, 403 `budget_exceeded` for the daily cap and PAUSE, semaphore
  (4 streams), weighted counting.
- Ops: `PAUSE` file, `GET /__demo/health` (local only), `GET /__demo/status` (public: available or not, for the
  scripted demo's button), JSON logs without prompts, cookies or credentials.
- Tests in `demo-gate/test/` (real Node gate + fake instance + fake upstream), `bun run test:demo-gate`, CI step.

Out: the server's freeRoam kind, fakes, fences and per-visitor budget (PR A/B), the snapshot builder and canary (PR C),
the web free-roam bar and limit modal and the scripted demo's button (PR D2), hosting (role users, pf, LaunchDaemons,
tunnel, Turnstile site: private ops).

## Decisions

- **Neutral error = HTTP 503, `{"type":"error","error":{"type":"api_error","message":"The demo is busy, try again in
  a bit."}}`, `x-should-retry: false`, no request-id, no retry-after.** Reasons, from the instance's code:
  - not 401: `model-proxy.ts` calls `broker.onUnauthorized` and marks the (dummy) credential refused;
  - not 400/402/403 with a request-id: `anthropic-refusal.ts` reads those from a loopback upstream as Anthropic's
    own account refusal (marked refused / no credit). Every gate answer drops request-id, so `accountRefusal` returns
    null even for the 403 `budget_exceeded` and the passed-through 400;
  - not 429: a retry-after above 60 s marks the connection limited (`onLongLimit`), a short one makes Claude Code retry;
  - not 529, and never the type `overloaded_error`: Claude Code retries those for minutes;
  - 503 reaches the engine unchanged (no branch in `model-proxy.ts`), the engine's text classifies as `crash`
    (`claude-parse.ts classifyError`: no auth, limit or context words), so the turn retries once and then shows its
    generic "stopped partway, try again", never the AI account message.
  - In-stream `error` events are rewritten to the same error object, so an `overloaded_error` inside a 200 stream does
    not start Claude Code's 529 retries either.
- **Budget / PAUSE = 403 `{"type":"error","error":{"type":"permission_error","message":"budget_exceeded"}}`**, the
  product proxy's shape, without request-id.
- **Prompt too long passes through** (status 400, the upstream's own error object, no request-id) so the engine's
  context recovery works (`CONTEXT_FULL`).
- Visitor routing is in memory: a gate restart ends every visitor session and the sweeper removes the orphans.

## Steps

1. Plan (this file).
2. `demo-gate/src`: config, log, pages, limits, pool, upstream, proxy, main.
3. Tests, CI step, README, changes fragment.
4. Checks: typecheck, check:docs, check:prepush, the new suite.

## Result

- `demo-gate/src`: config, log, pages, state (IP starts, daily tokens), pool, upstream, public (pages, start, proxy),
  main. No dependencies; runs with `node demo-gate/src/main.ts --config <file>`.
- 86 tests in `demo-gate/test` (unit + a real Node gate with fake instances), green under Bun 1.3.12 and 1.4;
  `bun run test:demo-gate`, in `bun run test` and in CI's full run next to the relay suite.
- Open: the instance's turn gets no "budget" event for the gate's 403 (only its own proxy sends one), so a global cap
  stop shows the generic failure until PR A maps `budget_exceeded` in the engine's error text; visitor routing is in
  memory (a gate restart ends every session); `/__demo/status` is public (available or not, nothing else).
