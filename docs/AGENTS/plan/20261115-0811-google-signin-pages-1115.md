# Google sign-in: return pages in the person's language with the real reason, the unverified-app line, and apps that cannot be connected yet stay findable

- Date (UTC): 2026-11-15 08:11
- Branch: `fix/google-signin-pages-1115`
- Status: in progress
- Where: server routes and Google sign-in services, web Connectors and the Google connector pages. Why: QA TC-2956,
  TC-2957, TC-2958, TC-2978, TC-2979 (see docs/REPOSITORY-RULES.md: components C and the web app)
- Version impact: patch: fixes words and one hidden list entry; one optional field added to two answers (older apps ignore it)

## Goal

People who connect Google Drive, Gmail, Calendar, Docs or Sheets see the page Google sends them back to in their own
language, with why it did not work (cancelled, a permission not ticked, the time ran out, this browser is signed in to
someone else or nobody) and one next step. A successful return no longer says "received": it says to go back to the app
and confirm the account. In the app, cancelling at Google says "cancelled", not "could not complete".

On a team that signs in through Trina's shared Google app (the hosting service's), one short line before Google opens
says Google may show "Google hasn't verified this app" and to press Advanced, then "Go to Trina AX". A company's own
Google app does not show it.

A Google app that is not available yet (Google's review) or not on this kind of server stays in Settings › Connectors
(Discover and search) with its short plain label, instead of disappearing and "Nothing matches".

## Scope

In:
- `server/src/integrations/google-drive/callback-page.ts`: the return page's words in 6 languages and the outcome map.
- Drive and Google apps callbacks report the reason (`callbackOutcome`); `callback()` keeps returning a boolean.
- `hostedApp` on `DriveConnection` and `GoogleAppView` (true in broker mode only) and one i18n key `google.unverifiedHint`.
- Web: cancelled wording for `consent_denied`, the unverified line, Discover keeps service_limited / unsupported apps.
Out: the connector catalog and URL validation (another session), the hosting service's own start page, the waiting
line under Google (#938), Drive in the onboarding Tools step (#843).

## Steps

1. Server: outcome type, page text, routes use the request's locale (`c.get('locale')`, as integrations.ts does).
2. API field `hostedApp`, docs:api.
3. Web: failed-key helper, unverified note, Discover filter.
4. Tests: unit (callback pages, outcomes per reason, hostedApp), web unit, e2e on Connectors.

## Plain-words check

"Google sign-in was cancelled", "Some permissions were not ticked", "This sign-in has expired", "This browser is signed
in to Trina AX as someone else": no codes, no OAuth, no "session", no "callback".

## Risks

No migration. The page still shows static words only and a same-origin `/login` link (no code or state carried). The
language for a browser that is not signed in comes from the anonymous locale (team default), never the flow's owner.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`, tests/unit c-drive-* and
c-google-*, `bun run test:web`, `bun run build:web`, e2e connectors specs.

## Result

(at the end)
