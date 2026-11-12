# Connector write cards: ask after outside content, Always allow for every connector, reconnect card for own connections

- Date (UTC): 2026-11-12 06:23
- Branch: `fix/connector-approval-gate`
- Status: done
- Where: server `integrations/connections/`, `chat/connect-service.ts`, shared API, web chat card. Why: the write card
  and the sign-in card are core chat permissions (see docs/REPOSITORY-RULES.md)
- Version impact: minor — a new choice on the write card (Always allow for every connector), a new reconnect card and
  an additive migration; the outside-content rule is a security fix that asks more often

## Goal

Three QA findings on connected services (TC-328, TC-130, TC-127):

1. **TC-328 (security).** A team connection set to "Run without asking" sent a change with no card right after the
   chat read a web page. Content someone else wrote (a web page, another person's file, an attachment, a connection's
   answer, a room's messages) can carry instructions. After it, every change at any connection asks on the card: team
   "Run without asking", a member's own Always allow, a Google app's Always allow. Reads do not change.
2. **TC-130.** The write card offers only Don't send / Send. Every connector's card offers **Don't send / Send once /
   Always allow**, as Google apps already do. Always allow is the caller's own setting for that connection.
3. **TC-127.** When a person's own connection needs a new sign-in or key, the chat gives text only. It gets the same
   card templates already get ("Sign in again to Notion"), and the answer goes on after the sign-in.

## Scope

In:
- `gate()` (tools.ts) reads the chat's outside mark (`chats.session_tainted`, `room_outside`, `rooms_seen`) and asks
  whenever it is set, before any allow path. The card then leads with one plain line saying why it asks.
- Always allow on every write card (not in a room's session or after a room read, as for Google apps today):
  - the person's own connection (their own, one made from a template, a Google app): the connection's write rule
    becomes "allow" (`write_policy`), like Google apps; Settings sets it back to Ask. Personal connections may now hold
    "allow" when the owner chose it on the card; choosing it in the Settings form stays team-only.
  - a team connection: a member cannot change the team's rule, so their choice is kept for them alone in a new table
    `integration_user_allow` (migration 346), tied to the connection's address; the connection's row in Connectors
    shows it with a button to ask again.
  - a connection already set to send without asking (it asks only because of outside content): Send once / Don't
    send, no Always allow (it would change nothing).
- connect_service takes `connection` (the id of the person's own connection that needs a sign-in or key; the tool
  list says it), and a call that names the address of their own broken connection gets the card too. The card is
  the template card with "Sign in again to …"; it signs in to the existing connection (never a second one) and
  "Not now" never removes it.

Out:
- Scheduled runs keep their rules (a team "allow" connection writes only when the schedule's card allowed it, a
  personal one only to pinned recipients). Asking after outside content cannot work there (nobody answers); whether
  such runs should refuse after a web read is an owner decision, noted in DECISIONS.
- Google apps' own reconnect stays on its page (it has its own sign-in flow).
- Admin team-connection forms, Connectors.tsx, AppDetail.tsx and admin Integrations.tsx (other work is on them).

## Steps

1. Plan (this file).
2. Server: outside mark in `gate()`; Always allow for every connection; migration 346; view field `alwaysAllowedByMe`
   and `DELETE /api/integrations/:id/always-allow`.
3. Server: connect_service `connection` + reconnect via the address match; tool list and call errors name it.
4. Shared API + web: `reconnect` on the card request; ConnectCard title; IntegrationRow line "You chose Always allow" +
   "Ask every time"; i18n in five languages (English first).
5. Unit tests that fail on the old code; DECISIONS entry; `changes/connector-approval-gate.md`.

## Risks

- Security: the new check is server-side and fails closed (a chat row that is gone counts as outside). The member's
  own allow never widens anything beyond what the admin's "allow" already does, is dropped when the address changes,
  and is never used in a scheduled run, a room or after outside content.
- More cards: a chat that read anything from outside asks before every change, also with Always allow. The card says
  why. A write's own answer is outside content too, so a second change in the same chat asks again.
- Migration: highest on dev is 344, an open PR takes 345, so this is 346 (additive, reader 1).
- Five app languages; phone and desktop for the row's new line.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, server unit tests for connections, Google apps,
connect_service and schedules (under Bun 1.3.12), web unit tests for touched components, e2e specs for chat cards and
the connect card.

## Result

Built as planned. Differences: the card's answer values are `allow` / `always` / `deny` (the yes / no card's values,
so clients and tests that answer `allow` still work); a team connection's own allow is turned back from its row in
Connectors (`integration_user_allow`, migration 346); the AI's text for a team connection that needs a sign-in now says
an admin fixes it. Scheduled runs are unchanged (noted in DECISIONS as the owner's call). Tests: new
`tests/unit/c-connector-approval-gate.test.ts` (6 of its 7 tests fail on the old gate), four TC-127 tests in
`connect-service.test.ts`, a Google app case, web `integration-always-allow.test.tsx` and a ConnectCard case.

Review fixes (independent review of #583): the outside check no longer counts `chats.room_outside`, which the own chat
sets before every connection tool runs (the first change of a clean chat asked); a card raised in a chat that read
something from outside offers no Always allow; a team "never" wins over a member's own Always allow (tested); a
member's own row goes when they lose access and they can clear it without access. Full-turn regression tests in
`tests/unit/c-connector-approval-turns.test.ts`.
