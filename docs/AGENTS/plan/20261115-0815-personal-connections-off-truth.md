# Personal connections off: say the truth in chat, on the row and page, in the hint; an expired sign-in says so

- Date (UTC): 2026-11-15 08:15
- Branch: `fix/personal-connections-off-truth`
- Status: in progress
- Where: server/src/chat, server/src/integrations/connections, server/src/routes/integrations.ts, web (lib/integrations,
  ConnectionPage, i18n). Why: QA TC-2930, TC-2931, TC-2936 (see docs/REPOSITORY-RULES.md: core connections area)
- Version impact: patch: wording and a refusal of a sign-in that was already unused; no API removed

## Goal

While a team has "Members can add their own connections" off:

- the AI is no longer told a member's own working connection "is yours in this chat" (its tools are not offered); it
  is told the team turned members' own connections off, so it tells the person to ask an admin (TC-2930 a);
- the member's row says "Off" instead of "Connected", and its page says it is not used in chats (TC-2930 b);
- signing in again to it is refused with one plain line, and the page no longer offers it (TC-2930 c);
- the switch's hint says what really keeps working: connections from a team template and the Google apps (TC-2931).

And a sign-in window allowed after its 10 minutes ran out says the sign-in expired and to connect again from the app,
instead of "sign in to the same team account" (TC-2936).

## Scope

In: connect_service's `working` answer; `personalOff` on a connection's view (shared type); the row status and the
page line; authorize refuses a member's own (non-template) connection while off; the hint in 6 languages; an `expired`
reason for the MCP sign-in return page, said only to the browser of the person who started it.

Out: Connectors.tsx, ConnectorsView.tsx, the Google return pages and GoogleApp*.tsx (other builders); access rules
(unchanged: nothing is widened); a key changed while off (`update`), a sign-in started before the switch went off and
finished after (both stay unused, as today).

## Steps

1. connect-service.ts: a member's own working connection (not from a template, not a Google app) while off: an early
   answer that says the team turned members' own connections off, no tools, no card.
2. store.ts view: `personalOff` true for such a row while off; shared/src/api Integration gets the optional field.
3. web: connectionRowStatus gives `off` for it; ConnectionPage shows "Off" and one line, hides Sign in again.
4. service.ts authorize: refuse with `personalOffSignIn` for such a row while off.
5. en.ts hint + 5 other languages.
6. service.ts callback: a flow whose state is `expired`, back in the browser of its own person: reason `expired`;
   routes FAILED_TEXT `callbackExpired` (6 languages, the page's locale as today).
7. Tests: unit for each, web unit for row/page, e2e shots at 1440/390.

## Plain-words check

"Off", "Not used in chats while your team has personal connections turned off.", "The sign-in expired. Close this
window and connect again from the app." No MCP, OAuth or token in what a person reads.

## Risks

No migration. The callback says "expired" only to the browser signed in as the flow's own person (as "cancelled"
does), so a stranger with the link learns nothing new. Six languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit c-integrations*/chat connect tests, `bun run
test:web`, `bun run build:web`, e2e of the connectors screens.

## Result

(at the end)
