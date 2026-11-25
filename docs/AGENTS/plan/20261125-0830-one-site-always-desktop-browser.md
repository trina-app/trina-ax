# One site "Always allow" for the desktop app's browser too

- Date (UTC): 2026-11-25 08:30
- Branch: `fix/one-site-always-desktop-browser`
- Status: in progress
- Where: shared/src/api, server/src/chat + tools, desktop/src/main/pane. Why: the server and the desktop app each keep
  their own site allowance, so one site asks twice and asks again on every new computer (docs/REPOSITORY-RULES.md).
- Version impact: minor: an Always on the desktop app's card now holds on every computer and shows in Settings;
  no migration, and old desktop apps and old servers ignore the new optional fields.

## Goal

The owner (2026-11-25): "아직도 윈도우에서는 권한을 많이 물어보던데? 이게 OS에 따라 다른가?". Measured on 0.18.1 with the
same account and requests (Mac desktop app, Windows desktop app, web): it is not the OS. When the AI uses the desktop
app's browser, two stores decide about one site:

1. the server's address card ("Always allow this site (naver.com)", `user_allowed_sites`, per person, every chat), and
2. the desktop app's own site card ("The AI wants to use stock.naver.com", `SitePermissions`, per computer and host).

A person who presses Always on the server card gets the desktop card for the same site right after; an Always on the
desktop card stays on that one computer and that one host, so a second computer (the Windows PC) asks for every site
again. Rule A and decision 20261123-one-always-allow say there is one Always, per person, everywhere.

## Scope

In:
- Each browser call carries the sites the person already allowed for it (their sites for good, and the address the
  server card or the person's own message just approved), and the office addresses they allowed. The desktop app takes
  them as allowed for that answer: no second card.
- An "Always allow" pressed on the desktop app's card comes back with the call's result and is kept as the person's
  site for good on the server (the same row the server card writes), so it holds in every chat and on every computer.
  An office-network Always is kept in the person's office grants the same way.
- Unit tests for both directions, old-desktop and old-server compatibility.

Out: the desktop app's per-computer list stays as a cache (it still works with an older server). Windows-only items
found on the way (the Windows app at 0.5.23 on the QA PC, the trina-ax: link handler) are reported, not changed here.

## Steps

1. `BrowserCall.sites` / `BrowserCall.office` and `BrowserResult.always` (optional, bounded).
2. Server `browserTool`: collect the approved sites while it gates the addresses; pass them; keep the desktop's Always.
3. Desktop pane: grant the call's sites for its answer; record Always answers on the call and return them.
4. docs/ASKS.md rows `desktop.site.web` / `desktop.site.private`; changes/ note.

## Decisions

docs/decisions/20261125-one-site-always-desktop-browser.md.

## Risks

Security: the desktop already follows the server's "Allow all websites" (Me.user.webAllowAll), so the server naming
allowed sites gives it nothing new; the desktop still asks for every site nobody allowed (redirects to another site,
links the AI clicks to a new site), and the office-network and this-computer blocks are unchanged. No migration.

## Tests

`bun run typecheck`, the unit tests for url-gate, the pane's site permissions and the browser tools, `bun run check:docs`.

## Result

(filled in at the end)
