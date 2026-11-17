# Desktop app: Sign in on a team Canva connection's Settings page

- Date (UTC): 2026-11-17 15:28
- Branch: `fix/desktop-canva-settings`
- Status: done
- Where: web/ (the connection page shared by Settings and Admin). Why: the page and its sign-in rule are one component (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a fix on one page

## Goal

In the desktop app, Settings › Connectors › Canva (a team connection, not signed in) said "Canva only lets you sign in
from an app on your computer. Open the desktop app and connect it there." with no button, although this is the desktop
app (QA TC-4794). Admin › Connected apps › Canva in the same app has Sign in, which works through the 127.0.0.1 return
(#977). The admin should get the same Sign in in Settings; the web keeps its words.

## Scope

In: one rule for when a connection's page offers Sign in (`signInOffered` in `lib/integrations.ts`) and one check for "this
window can do the computer-only sign-in" (`signsInOnComputer` in `lib/desktop.ts`, the bridge's `signInReturn` that the
sign-in already uses). Settings keeps a team connection read-only, except this one sign-in, in the desktop app, for whoever
may sign the connection in (an admin: the server's rule, unchanged). The page's one line then says it is not signed in yet
and to choose Sign in, instead of the server's "open the desktop app".
Out: the server; the web and the phone app (unchanged); other team connections in Settings (still managed in Admin).

## Steps

1. `signsInOnComputer` and `signInOffered` / `computerSignIn`.
2. `ConnectionPage` uses them for the button, ⋯ and the error line.
3. Unit tests (`connector-detail-tools`, `integrations`), a `changes/` note.

## Decisions

none

## Risks

Permissions: no widening. `canSignIn` (canManage) still gates it, and the server's `authorize` takes a team connection
from an admin only. A member keeps the server's "tell your admin" words. A desktop app from before the return address
shows the web's words.

## Tests

`bun run typecheck`, the touched web unit tests under Bun 1.3.12.

## Result

Built as planned.
