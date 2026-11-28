# Desktop app: Google connect finishes even when the session is recorded as a browser's

- Date (UTC): 2026-11-27 12:32
- Branch: `fix/desktop-google-connect`
- Status: done
- Where: server (Google Drive, Google apps), shared API bodies, web (the four Google sign-in starts, setup). Why: the
  bug is in how the server decides a sign-in came from the desktop app (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A bug fix; the new `client` field on the start bodies is optional, and older pages that leave
  it out behave as before.

## Goal

In the desktop app, Connect for Google Drive, Gmail, Calendar, Docs or Sheets kept loading on qa.trina.app. In a
browser it worked. After Google, the system browser showed "This browser is not signed in to Trina AX", and the app
waited until its sign-in wait ran out.

The desktop hand-off (google-drive/app-return.ts: a return without a session is held for the app's one-time code) is
offered only when the flow's **session** is recorded as `desktop`. A desktop app's session can be recorded as `web`.
One way is a team made in the desktop app (`setup` signed in as `web`). For such a session the server refuses the
return, and nothing tells the app.

## Scope

In:
- The four Google sign-in starts (Drive, Drive share, Google app personal, Google app team) take an optional
  `client: 'desktop'`. The web sends it in the desktop app. The flow keeps it sealed in its secret (no migration).
- The return without a session is held for the app's code when the session is `desktop` **or** the flow says so.
  Everything after that stays the same: only the starting session redeems the code.
- `setup` signs in with the client the page sends (default `web`), so a team made in the desktop app gets a desktop
  session.
- Tests: a repro (a `web` session in the desktop app: the old "not signed in" page, then the hand-off for Gmail and
  Drive), the phishing case for a browser session that says `desktop`, and setup's session kind.

Out:
- Other connectors (MCP and API sign-ins: connections/service.ts) also decide by the session's kind. A follow-up can
  give them the same start field; their loopback port rule (desktop sessions only) stays as it is.
- Sessions already recorded as `web` are not changed. Every new Google sign-in from the desktop app now carries the
  field, so they work without signing in again.

## Steps

1. Plan (this file).
2. Server: `FlowSecret.desktop`; `authorize`/`begin` take the start's client; `appOf`/`clientOf` read it; the held
   result keeps it.
3. Shared: `StartBody` on the four start endpoints; `SetupBody.client`.
4. Web: `googleStartBody()` in lib/driveSignIn.ts, used by the four starts; setup sends `clientKind()`.
5. Tests, decision file, changes note, docs/GOOGLE-DRIVE.md.

## Decisions

- [docs/decisions/20261127-desktop-google-connect.md](../../decisions/20261127-desktop-google-connect.md): the
  desktop app's page may say `desktop` when it starts a Google sign-in.

## Risks

- Security: saying `desktop` only changes how a return **without** a session ends. It is held for a one-time code that
  only the starting session redeems. A browser signed in as someone else is still refused. Anyone can already get the
  same result with a `client: 'desktop'` login made with curl, so the field gives nothing new. The phishing test from
  #98's review passes for a browser session that says `desktop`.
- Strict bodies (`authorizeDriveShare`, `authorizeGoogleAppTeam`) now accept `client`. Any other value is a 400.
- No migration. No i18n change.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit (Google Drive, Google apps, auth), tests/security, web unit
drive-sign-in and the connect pages.

## Result

Built as planned. The repro test fails on dev without the server change (400, no code) and passes with it.
