# Connector sign-in: an IPv6 /32 share level and a lower last-resort cap

- Date (UTC): 2026-11-12 00:36
- Branch: `fix/connector-signin-ipv6-cap`
- Status: done
- Where: `server/src/connectors/remote-mcp/oauth.ts` (the connector OAuth server is core, see docs/REPOSITORY-RULES.md)
- Version impact: patch, a limit change in a bug fix; no API, setting or data format change (limits are internal constants)

## Goal

Owner decision 2026-11-12 on QA TC-168 (after #482, review rev4):
1. One large IPv6 block can still stop every new connector sign-in: about 1,000 /48s (a routed /38 to /32) fill the
   30,000 last-resort cap in a minute, and then a new person gets 429.
2. 30,000 accepted anonymous requests a minute is about 100 s of main-thread SQLite work a minute on a loaded 2-core
   host (about 3.5 ms each), so the cap does not really bound the work.

## Scope

In:
- A second, coarser IPv6 level for busy minutes: an IPv6 /32 gets `widePerMinute` anonymous requests a minute in
  total, on top of each /48's 30. IPv4 keeps its one /24 level.
- `anonymousPerMinute` 30,000 -> 6,000.
- Numbers and their reasons in the comment above OAUTH_LIMITS.
Out: per-address limits (still first), busy level (2,400), the /48 and /24 shares (30), PKCE / state / redirect,
granted() and live credentials.

## Steps

1. oauth.ts: `wideNetworkKey()` (/32 of an IPv6 address), its read-only refusal and its count in `ingress()`,
   the new limits.
2. Unit tests that fail on origin/dev: 1,010 /48s spread over a few /32s at the real limits, then a new person
   (IPv4 and IPv6) still registers; the /32 refusal writes no rows; work per minute is bounded by the new cap.
3. rev4's in-process scripts (residual, bench) copied and pointed at this branch.

## Risks

- A whole ISP or cloud /32 shares 120 a minute during a busy minute (about 24 new connections). Outside busy minutes
  nothing changes.
- Each /48 adds at most its own 30 to its /32's count (review: one /64 could otherwise send 180 before the minute got
  busy and shut out its whole /32). Shutting out a /32 now takes 4 of its /48s: someone with 4 /48s in a large
  provider's /32 can still shut that /32 out during a busy minute.
- A lower cap is filled by fewer networks: (6,000 - 2,400) / 30 = 120 IPv4 /24s (was about 920), or 30 IPv6 /32s.
  That is the price of bounding the work; see the PR's decision section.

## Result

- `wideNetworkKey()` and the /32 level in `ingress()`; `widePerMinute` 120; `anonymousPerMinute` 6,000.
- Unit tests: 5 new in remote-mcp-oauth (4 fail on origin/dev, the single-host one fails on the first version of this
  branch); all remote-mcp-* pass (118).
- rev4's in-process residual: 1,010 /48s in 1, 4 or 16 /32s let in 2,400 (origin/dev: 30,000, a new person refused);
  a new person (IPv4 and IPv6) still registers. 300 IPv4 /24s x 30: 6,000 let in (origin/dev 9,000).
- Bench: an accepted IPv6 ingress costs about 4.5 ms on this host (one more upsert; IPv4 about 3.5 ms), so the cap
  bounds work at about 27 s a minute (origin/dev: 30,000 x 3.5 ms = about 105 s).
- Live through a local relay: 1,010 /48s x 3 over 4 /32s after a one-/48 flood: 450 let in, 2,580 refused (origin/dev
  3,030 let in); 100 registrations from fresh /48s of a flooding /32: all 429, rows +0 (origin/dev: 201, rows +300); a
  new IPv6 person connects to tools/call in the same minute. QA's IPv4 15 x 170: 2,410 / 140 on both.
