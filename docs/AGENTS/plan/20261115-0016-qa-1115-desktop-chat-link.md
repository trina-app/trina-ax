# A chat link from a browser opens the desktop app on that chat (QA TC-2266)

- Date (UTC): 2026-11-15 00:16
- Branch: `fix/qa-1115-desktop-chat-link`
- Status: done
- Where: desktop/src (link reader, team window) and web/src (chat title menu). Why: the desktop app's link handling and
  the web page that offers it are Team AX core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix to an existing link and one menu item

## Goal

QA TC-2266: `trina-ax://open?url=…` keeps only join pages; a chat address inside it opens the team's home, and a chat
page in a computer's browser has no way to open it in the desktop app. Expected: a link to a chat opened from a
browser can open the desktop app on that chat; without the app the browser just keeps working.

## Scope

In:
- Desktop: `desktopPagePath` (desktop/src/common/address.ts) reads the page inside a `trina-ax://open?url=…` link: only
  `/c/<id>`, `/rooms/<id>`, `/rooms/<id>/t/<id>` (with one `?m=<id>`), `/projects/<id>`; ids `[A-Za-z0-9_-]{1,64}`; the
  path must be exactly what the URL parser makes of it (no `..`, `\`, `%`, control characters). The link must already
  pass `readDesktopLink` (https, no user:password, no loopback, nothing around it). Anything else: as today.
- `AppWindow.offerLink`: such a page on the origin of a team this app already has opens that team on that page (no
  screen ④: no new server is connected; like Slack). Any other origin goes to ④ as today and opens the team home.
- Web: one "Open in the app" item in the chat title menu, in a computer's browser on macOS or Windows only (not inside
  the apps, not at phone width). Existing key `auth.openInApp`, all locales already have it.
- Unit tests for the parser; DECISIONS entry; changelog fragment.

Out: rooms and projects get no menu item (the desktop accepts their links); Linux (no scheme handler offered).

## Steps

1. Parser + tests (tests/unit/e-desktop-common.test.ts).
2. offerLink: known team + page → openTeam(id, path).
3. ChatTitleMenu item + web unit test.
4. DECISIONS, changes/qa-1115-desktop-chat-link.md, checks.

## Risks

URL handling: a web page can now move the desktop app to a page of a team it already has. Only fixed read-only routes
with id-shaped segments; the server's own access checks still apply (a chat the person may not see shows "not found").
No navigation to another origin, no other scheme.

## Result

Done as planned. The open team gets the page through its router (`bridge:open`, like a notification's click, no
reload); another remembered team or a room message (`?m=`) loads the address. Checks: typecheck, i18n, docs, web unit
(3376 pass), desktop unit `tests/unit/e-*` (339 pass).
