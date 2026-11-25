# Change cards name the thing they change, in the person's language

- Date (UTC): 2026-11-25 12:59
- Branch: `fix/card-detail-names`
- Status: done
- Where: `server/src/integrations/connections/` (card lines, words, gate) and `server/src/integrations/google-apps/`.
  Why: the connector change card is built there for every connector tool (see docs/REPOSITORY-RULES.md).
- Version impact: minor — the change card looks different (a new first line with the item's name, words in the
  person's language), no API or data change.

## Goal

QA on qa.trina.app (0.18.2-dev.20261125121022, after PR #585) found two things on connector change cards:

1. A Google Calendar delete card shows only the event's id. People cannot tell which event goes.
2. A Korean card still shows English: the field names (Action, Start time, End time, Timezone), the value `create`,
   and the tool as "Manage Event".

After this the card names the thing first ("일정  주간 회의") and says everything in the person's language.

## Scope

In:
- Before a change card for an existing thing on a Google app connection, Trina reads its name with the library's own
  read tool, on the same connection, and shows it as the card's first line (Calendar event: `get_events` by
  `event_id`; Gmail message: `get_gmail_message_content` metadata by `message_id`; a spreadsheet:
  `get_spreadsheet_info` by `spreadsheet_id`). Only when the card is about to show (not when it is skipped), at most
  5 seconds, only when that read tool is on for the connection. Nothing found or any failure: the card as before,
  with the id line. The name goes only to the person on the card, never to the AI.
- Every Google app tool (Gmail, Calendar, Docs, Sheets) gets Trina's own title in all six languages (text.ts
  GOOGLE_TOOL_WORDS), so "Manage Event" reads "일정 관리".
- Field words for the Google tools' argument names (event id, start time, time zone, attendees, spreadsheet, range …)
  on a library connection's card, and common names (start time, end time, time zone, location, action …) for every
  connector in FIELD_WORDS. Other names keep the humanized key ("page_id" -> "Page id") as before.
- Known values of the Google library's choice arguments (`action`: create, update, delete, rsvp, rename …;
  `response`, `send_updates`) in words on a library connection's card. Other connectors' values as sent.

Out:
- Docs: the library has no cheap read that names a document (its reads return the whole text). Docs cards keep the id.
- Name lookups for other MCP servers (no known read tool for them); their cards keep the id.

## Steps

1. card-lines.ts: `cardLines` takes the connection's value words; text.ts: GOOGLE_FIELD_WORDS, GOOGLE_VALUE_WORDS,
   GOOGLE_TOOL_WORDS for all four apps, more common FIELD_WORDS, the target words.
2. google-apps/names.ts: which tool and argument name an existing thing, the read that names it, the answer parsed.
3. tools.ts: `Sent.named` (lazy), read in `gate` just before the card is built, the line put first.
4. Tests: google-tool-titles.test.ts (every catalog tool in six languages, field and value words), a names test with
   the fake library (event title on the delete card; nothing found: the id only; the read off: no read).

## Decisions

None new. Follows docs/DECISIONS.md "Plain words in errors, cards and steps" and
docs/decisions/20261125-change-card-action-verb.md.

## Risks

- A read before the card: read-only, the same connection and person, the answer never reaches the AI, a short
  timeout. The name is service text: invisible characters out, one line, at most 120 characters.
- Card lines still say every value; a choice value in words is Trina's own list for the library; the exact JSON stays
  one click away.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit (google-tool-titles, c-google-apps-tools,
c-integrations-card-lines, change-card-action, the new names test), web/test/unit.

## Result

Built as planned in PR #599: `google-apps/names.ts` (the read and its parsing), `Sent.named` read in the gate just before
the card, the Google tool titles, field words and value words in six languages, and common field words for every
connector. Docs and other MCP servers keep the id (no cheap read names them).
