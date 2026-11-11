# An artifact that navigates away always gets the notice, also when its frame loads slowly

- Date (UTC): 2026-11-11 16:33
- Branch: `fix/artifact-navigation-notice`
- Status: done (PR open)
- Where: trina-ax core (`server/src/routes/web-static.ts` receiver; `web/src/components/SandboxFrame.tsx` comment;
  e2e). Why: the artifact frame of the core.
- Version impact: patch; the receiver writes the document a moment later, nothing else changes

## Goal

QA TC-218 (P2): an artifact whose script sets `location` (or any document in the sandbox frame) turned into
Chromium's blocked-page error (grey box, `ERR_BLOCKED_BY_CSP`) with no notice, in the desktop app and in Chrome.
The team page never left (the app's `frame-src 'self'` holds). Expected: the notice
"아티팩트가 다른 페이지로 이동하려 해서 멈췄어요." (or the artifact staying in place).

## Cause (confirmed with the real receiver, CSPs and wrapper in Chromium 156, Chrome 157 and WebKit)

`SandboxFrame` counts the frame's loads: the receiver, then the document written over it (`EXPECTED_LOADS = 2`); a
third load means the document left. The receiver writes the document as soon as the parent sends it, and the parent
sends it on the receiver's "ready", which the receiver posts before its own load event. When that message is handled
before the receiver has finished loading (a busy computer, an out-of-process frame), Chromium gives the frame one load
for both, and the blocked navigation's error page is load 2: not counted, no notice. Forced in a harness (the
receiver's load held back by a slow picture): Chromium and Chrome saw 1 load in total, the artifact gone, no notice.

Staying in place is not possible in Chromium: the frame's document has an opaque origin, where the Navigation API
fires no `navigate` events (tried), `location` cannot be wrapped, and Chromium replaces the document with its error
page when the parent's CSP blocks the navigation. WebKit keeps the document. So the fix is the notice, every time.

## Change

1. The receiver keeps the parent's document until its own `load` has fired and writes it then (next task). The loads
   are always two before the document can leave.
2. `SandboxFrame` comment says so (no logic change).

## Tests

- e2e `web/test/e2e/artifacts.spec.ts`: with the receiver's load held back 1.5 s (routed picture), a document sent
  on "ready" gives exactly two loads; the "wander" artifact gets the notice and its frame is removed. Both fail
  without the change (1 load; no notice).
- The rest of `artifacts.spec.ts` (13 cases) and the unit tests of the receiver (`tests/unit/d-web.test.ts`);
  `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`.

## Result

Built as planned, plus the receiver's unit test (`tests/unit/d-web.test.ts`: the one write after the receiver's load)
and DECISIONS (the artifact frame entry). The two new e2e cases fail without the receiver change (1 load; no notice)
and pass with it. `sandbox-exfil` (Chromium and WebKit), `artifacts` and `frame-files` e2e: 97 passed. The file
preview path in real Chrome 157 and Playwright Chromium 156 showed the notice before and after (its timing did not
merge the loads); the artifact panel is where the loads merged on a busy computer.
