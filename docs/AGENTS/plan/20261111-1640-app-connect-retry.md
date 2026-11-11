# Phone app: the link question offers Try again after a network error

- Date (UTC): 2026-11-11 16:40
- Branch: `fix/app-connect-retry`
- Status: in progress
- Where: phone app (`mobile/App.tsx`, `mobile/src/strings.ts`) and the shared link gate (`shared/src/team-link.ts` with its byte-identical phone copy). Why: a phone app bug (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix in the phone app with no API or data change

## Goal

QA TC-274 (found on an Android phone, TC sheet TC-133): a team link opened in the phone app while the network is down
shows "Could not reach the team server. Check the address, connection and HTTPS certificate." and the Connect button
disappears; only Cancel stays, also after the network is back. The person has to cancel, go back to the chat app and
tap the link again. The message also blames the address and the HTTPS certificate for a plain network drop.

## Scope

In: on screen ④, when the check could not reach the team (or saving failed), show a Try again button that connects to
the same link without a new yes, and a message about the connection only. `LinkGate` keeps the offer its last yes
confirmed and gives it back once more through `retry(host)`, only for that host, and forgets it on No, on a new link
and on `clear()`. The other errors (unknown team, suspended, not a team) keep only Cancel, as now.
Out: the desktop app's ④ (it has its own flow); the setup box's wording for a typed address (there the address can be
wrong, so the current text stays).

## Steps

1. `LinkGate.retry(host)` in `shared/src/team-link.ts`; copy the file to `mobile/src/team-link.ts`.
2. `mobile/App.tsx` LinkAsk: remember that a retry is possible; the button reads Try again and calls `gate.retry`;
   `gate.clear()` after a successful connect.
3. `linkUnreachable` in `mobile/src/strings.ts` (en, ko).
4. Unit test in `tests/unit/team-link.test.ts` for `retry` against both copies.
5. `changes/app-connect-retry.md`.

## Risks

The gate's rule stays: the first connect needs a yes for the host shown, after ④ has been on screen a while. A retry
reuses only that confirmed offer for the same host, and never after another link came in.

## Tests

`bun test tests/unit/team-link.test.ts`, `npm --prefix mobile run typecheck`, `bun run check:docs`.

## Result

Filled in at the end.
