# A connection never signed in is not listed as connected

- Date (UTC): 2026-11-12 00:57
- Branch: `fix/never-signed-in-connection`
- Status: done
- Where: `web/src/pages/Connectors.tsx`, `web/src/components/integrations/IntegrationRow.tsx`,
  `web/src/lib/integrations.ts`, `web/src/i18n/*`. Why: connectors are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, two display fixes

## Goal

QA TC-205. A member adds Notion, presses 저장하고 로그인, closes the sign-in window and presses 취소.

1. Connectors listed Notion under "연결됨" with a warning dot ("다시 연결 필요" for screen readers), while Notion's own
   page says "로그인 필요". It was never connected. A sign-in connection without a stored sign-in is now listed in a
   section of its own, "로그인 필요", and "연결됨" holds the ones that were connected (a lapsed sign-in there keeps
   its "다시 연결 필요" dot).
2. With the sign-in window closed, the row kept "새 창에서 로그인을 마쳐 주세요" until 취소. When the person comes back to
   the app (the window gets focus) and the sign-in has not finished, the row says so instead: "로그인이 아직 끝나지
   않았어요. 창을 닫았다면 다시 시도하거나 취소해 주세요." with 다시 시도 and 취소. The flow is still polled, so a
   sign-in finished a moment later still completes.

   `popup.closed` is not used: a sign-in page with a Cross-Origin-Opener-Policy makes the opener see the window as
   closed while it is open.

## Scope

In: the member's Connectors page; the sign-in panel of a connection's row (Connectors and Admin). Out: Admin's list
(each row shows its own status words), the chat's connect card.

Kept small for open PR #399 (connectors simple page): `ConnectorsView.tsx` / `TemplatesView.tsx` untouched.

## Steps

1. `lib/integrations.ts`: `awaitingFirstSignIn(i)` (auth oauth, no stored sign-in).
2. `Connectors.tsx`: such connections go to the "로그인 필요" section, not "연결됨".
3. `IntegrationRow.tsx` `useSignIn`: `away` when the window gets focus while waiting; `SignInPanel` shows
   `integrations.signIn.notFinished` with 다시 시도 / 취소. New key in five languages.
4. Tests (web unit): the helper; the hook (focus while pending → away; completed still completes).

## Risks

None beyond display. Five languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new unit tests, `bun run test:web`.

## Result

Built as planned. `awaitingFirstSignIn` (auth oauth, no stored sign-in) keeps a connection out of "연결됨". The
Connectors page adds a "로그인 필요" section, a few lines next to the existing list; its tiles keep the
`connected-app` test id so the e2e helpers still find them. In `useSignIn`, coming back to the window
(`focus`) while still waiting sets `away`. `SignInPanel` (now exported for its test) then shows
`integrations.signIn.notFinished` with 다시 시도 and 취소.

Tests:
- New `web/test/unit/integration-sign-in-state.test.tsx`: the helper; focus while pending gives the "not finished"
  line with retry and cancel, and a sign-in finished late still completes. It failed with the old hook.
- New in `web/test/e2e/integrations.spec.ts`: Notion added without signing in is under "로그인 필요", not in
  "연결됨"; a no-auth connection stays in "연결됨".
- `integrations.spec` + `connectors-hub.spec`: 20 pass. `bun run test:web`: 2636 pass. Typecheck, check:i18n and
  check:docs pass.

PR: https://github.com/trina-app/trina-ax/pull/518
