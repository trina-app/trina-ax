# One site "Always allow" per person, also for the desktop app's browser

- Date: 2026-11-25
- Status: accepted
- Supersedes: none
- Branch: fix/one-site-always-desktop-browser (owner, 2026-11-25: "아직도 윈도우에서는 권한을 많이 물어보던데? 이게 OS에 따라 다른가?")

- **Ask:** the owner saw many site questions on Windows, several in one answer. Measured on 0.18.1 with one QA account
  and the same five held-out requests on the Mac desktop app, the Windows desktop app and the web: the counts do not
  depend on the operating system. A fresh Windows profile and a fresh Mac profile ask the same way (the exchange-rate
  request: 1 server card + 1-2 desktop cards; the train request: 2 + 3). What differs is the computer: two stores decide
  about one site. The server's address card keeps "Always allow this site (naver.com)" per person
  (`user_allowed_sites`); the desktop app's browser keeps its own list per computer and per host. So the desktop card
  for stock.naver.com came right after Always on naver.com, and the Windows PC asked again for every host the Mac had
  already been told Always.
- **Rule:** there is one Always per person (decisions 20261123-one-always-allow, 20261116-always-allow-final-rule-a).
  Each `browser.call` carries what the person already allowed for it (`sites`: their sites for good, the address the
  server's card or their own message approved; `office`: office addresses they allowed); the desktop app takes them as
  allowed for that answer and shows no card of its own. An "Always allow" pressed on the desktop app's card comes back
  with the call's result (`always`) and is kept on the server as the person's own: a public host as its site
  (`user_allowed_sites`, the same row the server card writes), an office address in `browser_site_grants`. Where the
  server keeps no Always (the team's switch off, a confidential chat), nothing is kept and nothing is sent.
- **One site rule (review of #577):** a "site" is the registrable domain by the Public Suffix List with its private
  section (tldts), on the server and in the desktop app alike (shared/src/web-site.ts). The app's own approximation was
  broader (it took `lovable.app`, `eu.org`, `synology.me`, `run.app` and others as one site with their customers'
  hosts); with the server's sites now reaching the app that would have opened `attacker.lovable.app` with no card.
  tests/unit/web-site-one-rule.test.ts compares both sides on 50 hosts.
- **The kept site is the one the card names:** the desktop card's button reads "Always allow this site (naver.com)" and
  the server keeps exactly that site (`siteToKeep`): none for an IP address, a public suffix, or a host with a long
  (20+ characters) or random-looking name before its site, as the address card offers none there; such an Always
  stays on that computer for that host only.
- **Ports:** what the server sends holds on every port of that host or site, as the server's own site allowance does
  (it ignores the port). An answer given on the desktop card and kept only on that computer stays per host and port.
- **An Always is never lost:** the app keeps an Always until a call's result carries it, so one answered after its
  call ended, was stopped or ran out of time goes with the next call's result.
- **Office addresses:** an office grant the person has for a host goes with every call to it, also when the server's
  own lookup does not see it as an office address (a name only the office network resolves).
- **Not changed:** the desktop app still asks about every site nobody allowed (a redirect to another site, a link to a
  new site), the office-network and this-computer blocks stay, and its own list stays as a cache for an older server.
  A link the AI learned from a page is not sent as allowed (the desktop card is the check for it).
- **Why this is safe:** the desktop app already follows the person's "Allow all websites" from the team server
  (Me.user.webAllowAll), so the server naming single sites gives it nothing it could not already allow.
- **Tests:** tests/unit/b-browser-one-always.test.ts (server: sites and office go with the call, the desktop's Always
  is kept, switch off, confidential chat, another member, wire shape), tests/unit/e-pane-one-always.test.ts (desktop), tests/unit/web-site-one-rule.test.ts (one rule).
- **Version impact:** minor: an Always on the desktop app's site card now holds on every computer and shows in
  Settings › 트리나에게 허용한 것 (a new behaviour, no migration; optional wire fields).
