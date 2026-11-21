# Remove the "Turn this into slides too?" line under answers

- Date (UTC): 2026-11-21 04:35
- Branch: `fix/remove-slides-offer`
- Status: done
- Where: server/src/onboarding, shared/src/api, web/src/components/onboarding, web/src/i18n. Why: the one suggestion
  under a result is decided by the server and shown by the web app (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A suggestion line is no longer shown; no new feature, no API a client relies on breaks (the
  server just never sends that kind, and an older web app shows nothing then).

## Goal

The owner (screenshot, 2026-11-21): "이건 이제 안떠도 될듯?" After a long answer, a line above the message box offered
"Turn this into slides too?" [Make slides] ✕. It no longer shows.

## Scope

In: the `ppt` kind of the result suggestion: the server rule (`reportLike`, `PPT_SUGGEST_CHARS`), the contract kind
and key, the web branch and icon, the `resultTip.ppt.*` keys in all six languages, and its tests.
Out: the other suggestions under a result (`schedule`, `team-skill`, `contribute`, the unbuilt `deck-video`) stay
as they are.

## Steps

1. Server: drop the long-answer rule from `resultSuggestion`.
2. Contract: drop the `ppt` kind, its key from `SuggestionKey`, and `PPT_SUGGEST_CHARS`.
3. Web: drop the `ppt` branch, its icon and its words; drop the `resultTip.ppt.*` keys in en, ko, ja, zh, id, es.
4. Tests: drop the PPT cases; where a test used a long answer to show the next suggestion, expect nothing instead.
5. Decision file that supersedes the PPT part of "X — Lean onboarding"; changes/ note.

## Decisions

`docs/decisions/20261121-remove-slides-offer.md` (supersedes the PPT line of docs/DECISIONS.md "X").

## Risks

Old `ppt` rows in `suggestion_dismissals` stay; they are never read for anything else. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/b-result-suggestions.test.ts`,
`tests/unit/b-member-contribute.test.ts`, the web unit tests, the security case for the dismiss endpoint.

## Result

Built as planned. The `ppt` kind is gone from the server rule, the contract (kind, key, `PPT_SUGGEST_CHARS`), the web
line and the six languages; the API reference (`docs/site/reference/http-api.md`) is regenerated. The tests that used a
long answer to show "the next suggestion" now expect none. The security case for closing a suggestion uses
`team-skill` as its spoof key. Old migration 229's comment still names the line; migrations are not edited.
