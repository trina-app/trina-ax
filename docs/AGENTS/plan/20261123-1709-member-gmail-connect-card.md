# A member asking a chat to connect Gmail gets a personal connect card

- Date (UTC): 2026-11-23 17:09
- Branch: `fix/member-gmail-connect-card`
- Status: done
- Where: server/src/chat (connect_service), web/src/components/chat (the card). Why: the chat is where people ask, and
  non-developers do better with a button than with a path to follow.
- Version impact: patch, a fix that gives members the card the changelog implied (no API break: no new card field).

## Goal

QA TC-8034: a member who asks the AI to connect Gmail got no card, 3 of 3 times, only "Settings › Connectors › Gmail".
#354's plan kept that on purpose, but its changelog line ("Members keep their own connection") reads as a card. So this
is a real gap: a member now gets a card with "Connect my Gmail", which opens the same personal page as Settings.

## Scope

In:
- Gmail, Calendar, Docs, Sheets: a `member` for whom the app can be connected, with no own connection and no team
  account covering them, in an app with a person at the screen, gets the `google_app` card without `teamOffer`.
- The card's result is true in every branch: connected, Not now, timed out (read the app's state again after the card).
- Phone: no sign-in there, so the card says to connect on a computer, and "I've connected it" finishes it afterwards.
- 6 languages, docs/CONNECTIONS.md, docs/INTEGRATIONS.md.

Out: a sign-in inside the card (stays on the app's page); guests (no connections); scheduled, Slack and server-started
turns (nobody at a card: they keep the words); a member whose team account needs a new sign-in (keeps the words, which
say an admin fixes it).

## Steps

1. server: `googleAppOwnCard`, the member's card, the state read after the card.
2. web: the button's name, the phone line and finish button.
3. i18n, docs, `changes/member-gmail-connect-card.md`, tests.

## Decisions

None new: the personal flow and the team dialogs stay as they are.

## Risks

No migration. The member's card has no `teamOffer`, so the web card never mounts the team dialog or reads an admin
endpoint, and `done` checks the role again. The tool result never carries a team account's email.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`; tests/unit connect-service and connect-google-app
(member, admin, owner, team connection covering the member, timeout); web connect-card (member, phone).

## Result

Case (b), built as planned. Server: `googleAppOwnCard`, the member card without `teamOffer`, `googleAppNow` (the state read after the card closes, and a connected app that is not answering is said). Web: "Connect my {name}", and on a phone the on-computer line with "I've connected it" (this also replaces the phone admin's link to a page that cannot sign in). Six languages, the user docs in six languages, CONNECTIONS, INTEGRATIONS, ASKS.
