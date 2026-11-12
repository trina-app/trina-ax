# Connector sign-in: an IPv6 /32 share level and a lower last-resort cap

- Date (UTC): 2026-11-12 00:36
- Branch: `fix/connector-signin-ipv6-cap`
- Status: in progress
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
- A lower cap is filled by fewer networks: (6,000 - 2,400) / 30 = 120 IPv4 /24s (was about 920), or 30 IPv6 /32s.
  That is the price of bounding the work; see the PR's decision section.
