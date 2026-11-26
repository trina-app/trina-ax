# A connector step names the item, not the verb; card times read as dates

- Date (UTC): 2026-11-26 00:58
- Branch: `fix/card-step-verb-times`
- Status: done
- Where: `shared/src/step-key-input.ts` (the step line's key input), `web` (the ask card's field values). Why: the step
  line is chosen in shared for every connection; the card's values are drawn by the web client (docs/REPOSITORY-RULES.md)
- Version impact: patch, two display fixes with no API or data change

## Goal

Live QA on qa.trina.app (0.18.2-dev.20261125205145, Korean UI), a Google Calendar create-event card:

1. The step read `Google Calendar · 일정 관리 · "create"`: the call's `action` argument was shown where the event's
   name should be. The key input found no well-named argument (`summary` is not one of the name words) and fell back
   to the first required string argument, `action`. Any tool whose title argument has an unknown name and whose first
   required argument is a choice (`action`, `mode`, `type`, an `enum`) reads the same way.
2. Card rows showed start and end as raw ISO (`2026-11-27T15:00:00`).

## Scope

In:
- Step key input: `summary` (Calendar, Jira) and `headline` count as a name/title argument; the fallback "first
  required string argument" never takes a choice argument: a schema property with an `enum`, or a name that says it
  picks a kind of operation (action, operation, op, mode, method, verb, type, kind, format, status, …). For every
  tool, not only Calendar.
- Ask card: a field whose whole value is an ISO date or date-time is shown as a localized date and time in the
  person's app language (Intl, web lib/format.ts), as the wall-clock time written (no conversion), with its offset or
  "UTC" when the value names one. The exact JSON stays one click away, unchanged.

Out (reported, not changed):
- The event's time zone (Asia/Jakarta for a Korean user): the AI is told to give times in the turn's zone, which is
  the browser's zone sent with the turn (web store/chats.ts turnTimeZone, else the team setting); the QA browser runs
  on a Mac set to Asia/Jakarta. Working as designed (docs/decisions/20261117-ai-times-viewer-zone.md).
- A card made in English stays English after switching the app to Korean: the card's question, buttons, notes and
  field names are written by the server in the turn's language when the card is raised (TurnSpec.locale). Rendering
  them on the client from keys means a key form for every server card kind and for `sameCard`; not a small change.

## Steps

1. Plan (this file).
2. shared/src/step-key-input.ts: `summary`/`headline` as name words; skip choice arguments in the fallback. Tests in
   tests/unit/step-key-input.test.ts.
3. web/src/lib/format.ts `formatCardTime`; AskCard field values through it. Tests in web/test/unit.
4. changes/card-step-verb-times.md.

## Decisions

none

## Risks

A value reformatted on the card must still show all of it: only a whole-value ISO date or date-time is reformatted,
seconds kept when not zero, an offset kept; a fraction of a second or anything else is shown as sent. Five app
languages through Intl.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/step-key-input.test.ts, tests/unit/c-integrations-card-lines
.test.ts, `cd web && bun test test/unit`.

## Result

Built as planned: `choiceArg` in shared/src/step-key-input.ts (name words and schema `enum`/`const`), `summary` and
`headline` as title words; `formatCardTime` in web/src/lib/format.ts, used by the ask card's field values (a value
holding a mark stays as sent). Items 3 and 4 reported in the PR, not changed.
