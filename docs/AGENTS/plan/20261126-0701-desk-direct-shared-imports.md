# The desktop app bundles only the shared code it uses

- Date (UTC): 2026-11-26 07:01
- Branch: `fix/desk-direct-shared-imports`
- Status: done
- Where: desktop/, shared/. Why: the desktop imports `@mycel/shared` through barrels, so every API schema lands in the
  desk bundles and a server-only release changes the built Windows/Mac app (see docs/REPOSITORY-RULES.md)
- Version impact: patch: the built desktop bundles get smaller; no behaviour, screen or API change

## Goal

PR #629 found that the built desktop shell changed in 12 of 13 release pairs v0.8 → v0.19 while the desktop's own code
changed in about 5. The cause: `desktop/src` imports `@mycel/shared` and `@mycel/shared/api`, both barrels
(`shared/src/index.ts`, `shared/src/api/index.ts`). Bun cannot drop unused zod schemas (`z.object(...)` calls at module
top level), so 94 of 140 shared files went into `main.cjs` and 87 into each UI script. Any edit to any API schema
changed the desk app, so the installer was rebuilt and re-downloaded for nothing. After this change a server or API
change the desktop does not use leaves the built desk app byte-identical.

## Scope

In:
- `shared/package.json`: one wildcard export `"./*": "./src/*.ts"` so code can import one module
  (`@mycel/shared/desktop-bridge`, `@mycel/shared/api/local-apps`). Existing entries stay as they are.
- `desktop/src/**` and `desktop/build.ts`: every shared import names its module, never a barrel.
- `shared/src/browser-step-words.ts`: `BROWSER_STEP_VERB` and `BROWSER_STEP_FALLBACK` move out of `step-labels.ts`
  (which re-exports them), so the pane's permission question does not bundle the whole step list and the schemas behind
  it.
- `shared/src/api/auth.ts`: `CLAIM_DRIVE_FLOW_PATH`, used by `api/drive.ts` for the endpoint and by the desktop, which
  posted to `API.claimDriveFlow.path` (that pulled in the whole registry).
- Guard `tests/unit/desktop-shared-imports.test.ts`: fails on a barrel import in desktop source and builds the desktop
  entries to check no barrel and no unused API schema file is bundled.

Out: `desktop/e2e` (test code, not shipped) keeps its imports. Web and server keep the barrels (they use most of it).
`Me` (api/auth.ts) stays a full schema: the desktop checks `/api/me` with it, so its closure (`entities.ts`, …) stays
in the bundle by design.

## Steps

1. Baseline: build the desktop entries with sourcemaps, list the shared files per bundle.
2. Change imports, split the browser step words and the claim path.
3. Rebuild, compare; change a server-only schema (`api/rooms.ts`, `api/admin.ts`) and check every desk bundle is
   byte-identical (before the change: `main.cjs` and four UI scripts changed).
4. Guard test, desktop unit tests, desktop e2e (ci.config), typecheck, check:prepush.

## Decisions

none

## Risks

No behaviour change: the same functions and schemas run, only fewer unused ones are bundled. The wildcard export
exposes every shared module by path; that is what the explicit entries already did one by one.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/desktop-shared-imports.test.ts`, the desktop and local-app
unit tests (`e-desktop-*`, `e-local-apps*`, `desktop-*`, `office-update-desktop*`, `step-labels-*`, `i18n-languages`),
desktop e2e (`desktop/e2e/ci.config.ts`).

## Result

Shared files in the desk bundles: 94 → 29 (main.cjs 1,324,531 → 929,991 bytes; welcome/pane/hostbar/findbar UI scripts
~550 KB each → 2.5–15 KB). A change to `api/rooms.ts` and `api/admin.ts` leaves all built desk files byte-identical.
