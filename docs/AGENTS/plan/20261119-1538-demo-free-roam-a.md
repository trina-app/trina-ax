# Free-roam demo, part A: the server's free-roam demo kind

- Date (UTC): 2026-11-19 15:38
- Branch: `feat/demo-free-roam-a`
- Status: done
- Where: server/ and shared/ (demo mode). Why: the per-visitor demo instance is an ordinary server; everything it
  must refuse is decided on the server, whoever asks (see docs/REPOSITORY-RULES.md).
- Version impact: none (a demo-only switch; no change for any installed server)

## Goal

A visitor of the scripted Mina demo can open a real server ("Now try it yourself") as Mina, in a fictional company,
with the AI on, until a weighted token limit. This part makes the server side safe and countable: a `freeRoam` demo
kind, its fences, a line for the AI, a dummy AI connection and the demo's own limit.

## Scope

In:
- `kind: "freeRoam"` in the demo file (MYCEL_DEMO). Accepted only with `engine.authMode: managed`, a loopback
  listener, no relay, no TLS/tunnel/tailnet, a loopback model upstream and no dev environment.
- No dev-mode leaks: no DEV badge, no dev page, no relay default name, info logs, no `selfUpdate`/`hostDiagnostics`.
- Fences (demo/guard.ts, the route kit, the feature table, the turn's tool set): accounts and sign-in, invites and
  admin, connections, background and device work, code and heavy work, WebSearch and sub-agents off, upload caps.
- `demoRule` in the AI's instructions.
- A dummy "Demo AI" `anthropic-oauth` connection made at start; upstream 400/401/402/403 never mark it.
- The demo limit: cache reads count 0.1, `GET /api/demo` says `used`, `cap`, `signupUrl`; sends are refused with
  `budget_exceeded` + `params.reason: demo_limit`; a running answer ends through the existing budget path.

Out: the fakes (PR B), the Steepling content and snapshot builder (PR C), demo-gate and the web (PR D), hosting.

## Steps

1. shared: DemoFile `kind`, `limitTokens`, `signupUrl`, `uploadFileMax`, `uploadTotalMax`; DemoInfo `kind`, `used`,
   `cap`, `signupUrl`; `DEMO_LIMIT_REASON`.
2. app-config: `isFreeRoam`, readDemoFile's checks, info log level.
3. Dev flags: web.ts, auth/service.ts, relay-client, system/deployment.ts.
4. demo/free-roam.ts: start-up (Demo AI connection, settings), the limit, the upload count.
5. demo/guard.ts fences; http/route.ts pre-body fence and raw-route fence; chat/tools.ts tool fence; turn.ts
   WebSearch/sub-agents off; prompt.ts demoRule.
6. proxy: no account marking in free roam; the demo limit in overBudget/budgetBlock; broker weight.
7. Tests `tests/unit/a-demo-free-roam.test.ts`, decision record, changes fragment, docs:api.

## Decisions

docs/decisions/20261119-demo-free-roam-a.md

## Result

Built as planned, plus the coordinator's ask: demo-gate's 403 budget_exceeded ends a turn as a budget stop ("The live demo is resting"), and every other failed answer reads "The demo is busy, try again in a bit.". Tests: tests/unit/a-demo-free-roam.test.ts.
