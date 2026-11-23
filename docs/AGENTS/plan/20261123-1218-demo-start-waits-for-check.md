# Demo Start waits for the browser check instead of failing

- Date (UTC): 2026-11-23 12:18
- Branch: `fix/demo-start-waits-for-check`
- Status: in progress
- Where: demo-gate/src/pages.ts and a new demo-gate/src/start-script.ts. Why: the gate's landing page and its words live there.
- Version impact: patch. A bug fix on the demo landing page, with no API or config change.

## Goal

Turnstile takes about 8-15 s. A visitor who presses Start before it finishes gets an error page today. After this
change they press once, the button shows a calm waiting state, and the demo starts when the token arrives.

## Scope

In: a small inline script on the pages with the Start form, one new string in six languages, button states, tests.
Out: every server check. `start()` and `turnstileOk()` in public.ts stay as they are. No change to the files of #446.

## Steps

1. Add the `checking` string in all six languages.
2. Add the start script: hold the submit until a token exists, submit exactly once, and show the error with Try again
   when Turnstile fails or expires. A watchdog covers a Turnstile script that never loads.
3. Allow only that script in `PAGE_CSP`, by its sha256 hash. No `unsafe-inline`.
4. Reserve the error line's height so nothing moves. Use aria-busy and aria-disabled, never `disabled`, so focus stays.
5. Test the press orders, then check a real browser at 1440 and 390.

## Decisions

none

## Risks

The CSP gains one script hash; a test keeps the hash equal to the script. Without JavaScript the form behaves as
before and the server still refuses a missing token. Back navigation must not leave the button stuck.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, `bun run test:demo-gate`, and a real browser with
Turnstile's public test keys.

## Result

Filled in at the end.
