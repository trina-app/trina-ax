# Demo gate: daily stats, a counted "Start free", and the scripted demo's beacon

- Date (UTC): 2026-11-21 11:23
- Branch: `feat/demo-gate-stats` (builds on `feat/demo-gate-limit-usage`, PR #235: both touch `upstream.ts` and `gate.test.ts`)
- Status: done
- Where: demo-gate/ (the gate is the only place that sees demo visitors), web/demo/ (the scripted demo), scripts/demo/steepling/ (the free-roam demo file)
- Version impact: patch — the scripted demo build (web/demo) sends anonymous events on ax.trina.app; demo-gate is an operator tool, the released app is unchanged

## Goal

Know how the live demo is used, day by day, without any visitor id: how many land, start, ask, hit the demo limit,
click "Start free", how long they stay active, and why starts are refused. And count the scripted demo's funnel
(start, steps, finish, "Now try it yourself", sign-up) on ax.trina.app.

## Scope

In:
- `demo-gate/src/stats.ts` (new): `GateStats(stateDir)`, daily counters per UTC day and locale (`en`/`ko`/`-`), saved
  to `stats.json` (0600, temp file + rename, 500 ms delay), 400 days kept; `bump`, `duration`, `read`, `flush`.
- Counters in `public.ts` (landing, busy, refusals split paused/full/limit, Turnstile pass/fail, starts, start failed,
  resumes, questions = 2xx `POST /api/chats/:id/messages`), `upstream.ts` (tokens; `hitLimit` once per instance at
  `cap / instanceCapMargin`), time active at `pool.end()` through an `onEnded` hook (`lastSeenAt - assignedAt`;
  `lastSeenAt` on each proxied request and WebSocket close, now when a socket is still open).
- `GET /__demo/stats?days=30` (same check as health) with `distinctStarters24h` from `GateState`'s start hashes.
- `GET /__demo/go/start-free`: counts `startFree`, 302 to `links.pricing`. `make.ts` `signupUrl` points there.
- `web/demo/beacon.ts` (new): `sendBeacon('/e', {e,p,l,x})`, a no-op on every host but ax.trina.app. Called from
  `overlay.tsx` (demo_start, demo_step N, demo_finish once) and `end.tsx` (try_click, cta_click signup:demo_end).

Out: the website's `/e` Worker endpoint, Analytics Engine, `stats.sh`, privacy text (step 3, the website repo); a
snapshot rebuild (after merge); any per-visitor record.

## Steps

1. stats.ts + unit tests (buckets, UTC roll-over, save/reload, 400-day pruning, distinct starters).
2. Wire counters in main/public/pool/upstream; `/__demo/stats`, `/__demo/go/start-free`; gate tests.
3. make.ts signupUrl; beacon.ts + calls; web unit test (no-op off ax.trina.app).
4. README, changes note.

## Decisions

none (the plan at the owner's request: counters only, no visitor ids)

## Risks

Privacy: stats.json holds counters only (a test checks it has no address and none of the start-limit hashes). The
beacon sends no id or cookie and only on ax.trina.app. `/__demo/stats` is loopback-only, like health.

## Tests

`bun test demo-gate/test`, web `test/unit/demo-beacon.test.ts`, `tests/unit/demo-free-roam.test.ts`, `bun run typecheck`,
`bun run check:prepush` (Bun 1.3.12).

## Result

Done as planned.
