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

Claude's / ChatGPT's servers send for many people from few networks: during a busy minute a network gets 30 anonymous
requests (about 6 new connections a minute per network); outside busy minutes nothing changes. Connected apps (tokens,
live refresh) never use the shared bucket. One more small write per anonymous request (the network counter; rows
expire like the others). The sticky row: checked on phone and laptop sizes; scroll-padding keeps focused boxes clear.

## Result

Done: unit tests (remote-mcp-oauth, remote-mcp-http) and Playwright (connectors.spec.ts at 1280x720 and 390x844) pass;
the two new Playwright cases fail on the old page. Live relay check: see the PR.
