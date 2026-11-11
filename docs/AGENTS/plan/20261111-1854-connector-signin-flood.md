# Connector sign-in: a few flooding addresses cannot stop new connections; Allow reachable on small screens

- Date (UTC): 2026-11-11 18:54
- Branch: `fix/connector-signin-flood`
- Status: done
- Where: `server/src/connectors/remote-mcp/oauth.ts`, `web/src/pages/ConnectorConsent.tsx`. Why: the connector OAuth server and its consent page are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, two bug fixes; no API, setting or data format change (limits are internal constants)

## Goal

QA TC-168 (11-12, through a local relay):
1. 15 addresses x 170 metadata requests in one minute (each under its own 180) filled the server-wide anonymous
   bucket (2,400 a minute); for the rest of the minute every new Claude/ChatGPT connection got 429, also from fresh
   addresses and on loopback. Repeating it every minute keeps every new connection out.
2. The consent page does not scroll inside the app shell: "Allow and continue" is below the fold at 1280x720 and on a
   phone (390x844), and the mouse wheel / a finger does nothing.

## Scope

In:
- The shared bucket becomes two levels. Past `busyPerMinute` (2,400) the minute is busy: only a network (IPv4 /24,
  IPv6 /48) that sent at most `networkPerMinute` (30) anonymous requests this minute gets through; refused ones are
  not counted. `anonymousPerMinute` (30,000, was 2,400) is only the last-resort cap that bounds work and rows. Filling
  it in a busy minute takes about 900 networks; a person connecting needs about 5 anonymous requests.
- Consent page: its own scroll area; the Allow / Deny row sticks to the bottom of the window.
Out: per-address limits, table caps and eviction (unchanged, QA found them right).

## Steps

1. oauth.ts: `networkKey()`, the busy-minute share in `ingress()`, the new limits and their reasons.
2. Unit tests: QA's flood (15 x 170) then a full new connection; IPv6 /48 share; refused requests do not fill the cap.
3. ConnectorConsent.tsx: scroll container + sticky action row; Playwright at 1280x720 and 390x844.
4. Live check through a local relay with QA's scripts.

## Risks

- Claude's / ChatGPT's servers send for many people from few networks. During a busy minute a network gets 30 anonymous
  requests, about 6 new connections a minute per network. Outside busy minutes nothing changes.
- The cost of making a minute busy is unchanged: 14 addresses (2,400 / 180). What changes is that a busy minute now
  slows only the flooding networks; it no longer stops everyone.
- Connected apps (tokens, live refresh) never use the shared bucket.
- Writes: a request refused by its network's share is refused before anything is written, so ever new addresses of one
  network add no rows. Per anonymous request let in, one more small write (the network counter). The last-resort cap
  is 30,000 a minute, 12.5 times the old 2,400, so the bound on rows written in a minute is about 12.5 times higher too:
  about 3 per request, plus one hour-long row per registration.
- Left open (owner): filling the 30,000 cap in one minute takes about 900 IPv4 /24s, or 900 IPv6 /48s. An attacker
  with a large IPv6 block (a /32 holds 65,536 /48s) can still do that. A coarser IPv6 level (for example a share per
  /32) would close it, at the cost of counting large providers as one network.
- The sticky row was checked on phone and laptop sizes; scroll-padding keeps focused boxes clear.

## Result

Done:
- Unit tests pass (remote-mcp-oauth, remote-mcp-http), including a row-count check that fails on the first version
  (125 rows instead of 25).
- Playwright passes (connectors.spec.ts at 1280x720 and 390x844). The two new cases fail on the old page.
- Live, through a local relay with QA's scripts (15 x 170 metadata requests in one minute):
  - this branch: 2,410 let in and 140 refused, and a new person connects all the way to a tool call.
  - origin/dev: 2,400 let in and 150 refused, and the new person gets 429 at register.
