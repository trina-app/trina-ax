# Desktop: no bridge for a team page whose document has an opaque origin

- Date (UTC): 2026-11-11 17:45
- Branch: `fix/desktop-bridge-opaque-origin`
- Status: in progress
- Where: `desktop/src/common/trust.ts`, `desktop/src/main/main.ts`, `desktop/src/main/app-window.ts`. Why: the
  desktop app is core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no new behaviour for the team page

## Goal

QA TC-220. `<team>/sandbox/frame` (the artifact receiver) is served with `Content-Security-Policy: sandbox
allow-scripts`, so its document has an opaque origin ("null"). Loaded as the whole page in the team window, it still
got `window.mycelDesktop`: `setBadgeCount(7)` changed the Dock badge, `notify` was accepted, and `connection.get()`
returned the team address. The main process checks the frame URL's origin (the team address), not the document's.
A sandboxed document is not the team page, and must get no bridge.

## Scope

In:
- `isTrustedAppSender` also requires the document's own origin (`WebFrameMain.origin`, "null" for an opaque one) to
  be a team origin. `SenderFrame.origin` is required, so no caller can leave it out.
- `main.ts` `fromApp` passes `senderFrame.origin`. `bridge:info` then answers null, so the preload exposes no bridge
  at all, and every later call is refused too.
- `app-window.ts` `chooseFiles` passes the CDP frame's `securityOrigin`.

Out: the server's sandbox page itself (it is right to be sandboxed).

## Steps

1. `trust.ts`: `origin` in `SenderFrame`; the check.
2. `main.ts`, `app-window.ts`: pass it.
3. Tests:
   - `tests/unit/e-desktop-common.test.ts`: origin "null" and another origin are refused, at a team URL too.
   - `desktop/e2e`: the fake team server serves `/sandbox/frame` with the sandbox CSP. Loaded as the top page, it has
     no `window.mycelDesktop`, and the team page keeps it.

## Risks

Security (who gets the desktop bridge): "Security: merge needs owner OK". If `senderFrame.origin` were ever empty
for the real team page, the bridge would be gone. The e2e checks the team page still has it in a real Electron.

## Tests

`bun run typecheck`, `bun test tests/unit/e-desktop-common.test.ts`, the desktop e2e test for the bridge (one spec,
through `heavy.sh`).

## Result

