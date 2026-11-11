# Relay: slow readers can no longer take a team offline

- Date (UTC): 2026-11-11 12:18
- Branch: `fix/relay-slow-streams`
- Status: in progress
- Where: `relay/` (the relay server). Why: the relay forwards every visitor to the team server and is where streams are
  held open (see docs/REPOSITORY-RULES.md)
- Version impact: patch — a fix inside the relay; two new optional settings, no protocol or API change

## Goal

QA TC-199 (audit finding #3): from one machine, 1,100 connections that ask for a large JS file and never read the answer
fill all 1,024 streams of a team (2 control connections × 512) in about 12 seconds. A normal browser then cannot load
`/login` through the relay, and the relay never closes those sockets. Reproduced on a local relay: `/api/health`
through the relay got no answer in 8–30 s while the team server answered directly in 0.01 s; the team server had
answered the request, but its frames waited behind the slow streams' data.

After this change one address can hold only part of a team's streams, and an answer the visitor stops reading is cut,
so the people of the team can still open the app during such a flood.

## Scope

In:
- Per-address cap: one client address (the real visitor IP the relay already uses, `CF-Connecting-IP` from trusted
  proxies) can have at most `RELAY_MAX_STREAMS_PER_IP` HTTP streams open to one team (default 256 = half of one control
  connection, so at least half of one connection always stays free for everyone else; 0 = off). Over the cap the
  relay answers at once with its "team server is busy" page (503, Retry-After 5) and closes that connection. WebSockets
  are not counted: a WebSocket only stays open when the team server accepted it (a signed-in member).
- Write stall: an HTTP answer with bytes waiting for the visitor, where the visitor's socket took nothing for
  `RELAY_CLIENT_STALL_MS` (default 30 s), is cut: the stream is reset (CANCEL, so the team server stops), the socket is
  closed. Progress is counted per written chunk (≤ 64 KB), so a slow but working connection is never cut.
- Counters for both (`/_stats`, `/metrics`: `relay_http_requests_total{outcome="ip_limit"}`,
  `relay_client_stalls_total`). The relay log keeps only team ids, counts and times (no IPs).
- README settings table; DECISIONS note; regression tests against the Node relay.

Out:
- A flood from many addresses (botnet): the stall cut frees streams, but no per-team admission control beyond that.
- Cloudflare-side rate limits (operator settings, not this repo).

## Steps

1. `relay/src/config.ts`: `maxStreamsPerIp`, `clientStallMs`.
2. `relay/src/relay.ts`: count open HTTP streams per (team, address); refuse over the cap before waiting for a
   connection. Track the last time a chunk reached the visitor's socket; the 1 s sweep cuts answers that stalled.
3. `relay/src/metrics.ts`: the two counters.
4. Tests in `tests/relay/` (real Node relay): a cap refusal for one address while another address is served; a
   never-reading socket is cut and its team stream freed; a slow but reading client is not cut.
5. Verify on a local dev relay with the QA flood script (1,100 connections from one address) and a real browser
   from another address signing in.

## Risks

- An office behind one NAT address shares the cap. The web app's HTTP requests are short (realtime uses the
  WebSocket, which is not counted), so 256 at once is far above a normal office; the setting can be raised.
- A relay behind a local tunnel without `--trusted-proxies` sees every visitor as 127.0.0.1: the cap would then apply to
  everyone together. The README already requires `--trusted-proxies 127.0.0.1,::1` there; the new row says so too.
- No migration, no UI text, no permission change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/f-relay*.test.ts`,
`bun run test:relay` (Node relay).

## Result

(filled in at the end)
