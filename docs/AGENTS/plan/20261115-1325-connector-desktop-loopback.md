# Connectors that sign in only from an app on the computer: the desktop app signs in through 127.0.0.1

- Date (UTC): 2026-11-15 13:25
- Branch: `feat/connector-desktop-loopback-signin`
- Status: in progress
- Where: server/src/integrations/connections, server/src/routes/integrations.ts, shared/src/api, shared/src/desktop-bridge.ts,
  desktop/src (main process and preload), web/src/components/integrations. Why: connector sign-in is open core, and the
  desktop shell is component E (see docs/REPOSITORY-RULES.md)
- Version impact: minor: a new way to connect (a desktop app sign-in) and an optional field in the authorize API and the
  desktop bridge; nothing removed

## Goal

Canva, Intercom and Square refuse the sign-in address Trina gives them (`https://<team>/api/integrations/oauth/callback`)
because it is not on their list, so Connect says "This service lets only apps it has approved sign in". They do accept
the address apps on a computer use, `http://127.0.0.1:<port>/callback` (RFC 8252, how desktop MCP clients sign in).
Probes (2026-11-13, Square checked again 2026-11-15):

| Service | https callback | 127.0.0.1 callback |
| --- | --- | --- |
| Canva | registration 201, sign-in page 400 "Invalid redirect URI." | registration 201, sign-in page 302 to Canva's sign-in |
| Intercom | registration 400 "not in the allowlist" | registration 201, sign-in page 200 |
| Square | registration 400 "domain not in allowlist" | registration 201, sign-in page 200 |
| Figma | registration 403 | registration 403 (stays "approved apps only") |

After this change:
- In the Trina desktop app, Connect for these services just works: the app opens a one-time return address on
  127.0.0.1, the service sends the browser there, and the app sends it on to the team's own sign-in return page.
- On the web and in the phone app, Connect says plainly: "Canva only lets you sign in from an app on your computer.
  Open Trina's desktop app and connect it there." with a link to Settings › Apps, where the desktop app is downloaded.
- Figma and every other service behave as before.

## Plain words check (users are office workers, not developers)

The person sees only: Connect, the service's own sign-in page in their browser, then "Connected". On the web: one
sentence naming the service and the desktop app, and a "Get the desktop app" link. No "loopback", "redirect",
"127.0.0.1", "OAuth", "client" or "port" anywhere on screen. The browser shows the address 127.0.0.1 for a moment
while it is passed on; nothing is drawn there.

## Scope

In:
1. Desktop main process: `desktop/src/common/sign-in-return.ts` (pure, unit-tested) and IPC in `main/main.ts`, bridge
   `signInReturn: { open(): Promise<number | null>; close(port: number): void }` in the preload and the shared
   contract. `open` works only for the team page's top frame (`fromApp`) on an https team address. It binds
   127.0.0.1 only, on a free port the system picks. It answers exactly one `GET /callback` (any other path, method or
   Host gets 404 and does not use it up) with a 302 to `https://<team origin>/api/integrations/oauth/callback?<the same
   query>`, then closes. It closes after 10 minutes unused, when the page closes it, when another one opens, and when
   the team changes. It never reads or keeps the code (the query is passed on as it came) and the target is never taken
   from the request or the page.
2. Server: `POST /api/integrations/:id/authorize` takes an optional `loopbackPort` (1024-65535). The route passes it on
   only for a desktop session (`sessions.client = 'desktop'`, set at sign-in); from any other session it is ignored.
   The answer gets `loopback: true` when the sign-in uses it. There is one authorize route for personal, team and
   template connections (a template's connection is a personal row), so all of them get it.
3. Client choice (oauth.ts `chooseClient`, unchanged order): registered app for the https callback → client metadata
   document → only when both were refused (today's `oauth_approved_apps_only`): a registration for
   `http://127.0.0.1:<port>/callback` and the same preflight. Its redirect is in the flow's sealed client, so the token
   exchange sends it; refresh sends none. Callback unchanged: it finds the flow by its state, through the team origin.
4. Web or phone session (no port): when every https client was refused, one probe registration with a 127.0.0.1
   redirect and its preflight tell whether a desktop sign-in would work: then `oauth_desktop_only`, else
   `oauth_approved_apps_only`. The probe's client is never used. The verdict is remembered per sign-in server for 6
   hours (memory), and then a web try at such a service registers nothing and a desktop try goes straight to the
   127.0.0.1 registration, so repeated Connects never pile up registrations at the service.
5. Words: `oauth_desktop_only` in ko/en/id/ja/es/zh, sent with `params.reason` so the web adds "Get the desktop app"
   (Settings › Apps). The connection's status line uses the same words.
6. A desktop app from before this change sends no port and keeps today's "approved apps only" words.

Out:
- The callback still needs the system browser signed in to the same team account (as every connector sign-in from the
  desktop app does today; the page says so). Passing the return through the app's own session is a later step.
- Figma (refuses even 127.0.0.1). `localhost` (127.0.0.1 is accepted by all three; one host keeps it simple).
- The phone app cannot run a listener for another browser: it gets the desktop sentence.

## Threats and answers

- **An attacker-chosen port.** Only a desktop session's port is used, and the address is always the person's own
  computer (127.0.0.1, `/callback`). Another program listening on that port could read the code and state, but the
  code is useless without the PKCE verifier, which never leaves the server, and the callback finishes a flow only in a
  browser signed in as the person who started it (unchanged), so it can only finish that person's own sign-in.
- **Open redirect.** The listener's only redirect target is the signed-in team's https origin plus the fixed callback
  path, both taken in the main process from the window's team, never from the request or the page; only the query is
  carried over (at most 8 KB). The server never redirects to 127.0.0.1 itself; the service does, to the address it
  registered.
- **A loopback client from a web session.** The port is dropped unless the session is a desktop one. Session kind is
  what the app said at sign-in (the same rule that gives browser tools to desktop sessions); a person who forges it gets
  their own browser sent to their own 127.0.0.1, nothing more.
- **DNS rebinding / other local pages.** The listener checks the Host header (`127.0.0.1:<port>`), answers only GET
  `/callback`, sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and goes away after one use or 10
  minutes. A page that hits it gets a redirect to the team's own callback, which refuses a state it did not start.
- **Flooding the service.** The 20 sign-in tries an hour stay (`FLOWS_PER_HOUR`); `oauth_desktop_only` counts as a
  refused try like `oauth_approved_apps_only`. At most one 127.0.0.1 registration per authorize; the verdict memory
  stops repeated probes.

## Steps

1. This plan (first commit).
2. oauth.ts: `loopbackRedirect(port)`, `loopbackClient(...)`; service.ts: `authorize` options, `clientFor` loopback
   step and probe, verdict memory, `oauth_desktop_only` counted as a refused try; text.ts reason in six languages.
3. shared contract (`authorizeIntegration` body and answer, `DesktopBridge.signInReturn`), route reads the session kind.
4. Desktop: `common/sign-in-return.ts`, IPC `bridge:sign-in-return-open/close`, preload, close on team change.
5. Web: useSignIn opens a return address in the desktop app, passes the port, closes it when unused or cancelled; the
   failed panel's "Get the desktop app" link; i18n in six languages.
6. Tests, docs (docs/INTEGRATIONS.md, docs/DECISIONS.md), `changes/connector-desktop-loopback-signin.md`.

## Risks

No migration. The desktop bridge gains an optional member (older web pages ignore it; older apps lack it). Six app
languages. Desktop and phone covered above. A real sign-in at Canva, Intercom or Square needs test accounts we do not
have: the services' answers are recorded from unauthenticated probes.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/c-integrations-*.test.ts`,
`connect-service*.test.ts`, the desktop unit tests (`tests/unit/e-desktop-*.test.ts`) and web unit tests for the
sign-in panel. New: Canva / Intercom / Square / Figma shapes; desktop session gets a 127.0.0.1 sign-in, web session
gets `oauth_desktop_only`, a port from a web session is ignored, the callback exchanges with the 127.0.0.1 address,
refresh, flood limits unchanged; the listener binds 127.0.0.1 only, one request, exact path, team origin only, closes
after use and after the timeout.

## Result

Filled in at the end.
