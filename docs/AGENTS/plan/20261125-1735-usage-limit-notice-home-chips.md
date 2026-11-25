# Usage-limit notice by its cause; Home suggestions in the reader's language

- Date (UTC): 2026-11-25 17:35
- Branch: `fix/usage-limit-notice-home-chips`
- Status: in progress
- Where: server/src/chat (often asked, limit errors), shared/src/api/errors.ts, web/src (chat errors, Home, i18n).
  Why: both are the team server's and web app's own words (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Wording and a language fix of existing screens; one additive column, no new feature or API.

## Goal

1. When the team's AI connection is at its provider's limit (a Claude subscription used up until its reset, the proxy's
   403 `subscription_limited`), a member reads "Ask your admin to add more AI usage". An admin cannot raise a
   provider's limit, so that is wrong. Only a limit an admin set (a per-member, group or team budget in Admin › Usage)
   can be raised by an admin.
2. On Home, with Korean on screen, "what my group often asks" shows English chips ("Find my files", "Share it so they
   can view it", "Show…"): the daily AI run writes them in the team's default language for everyone. At 390 px the
   third chip runs off the screen edge.

## Scope

In:
- One place (web `lib/chatErrors.ts usageLimitOf`) decides the cause of a "used up" answer from the stored error:
  `budget` (a limit an admin set: `budget_exceeded`, not the demo's) or `provider` (`rate_limited` with reason
  `usage_used_up`), with when it comes back. The words follow from cause × role:
  - budget: as now (the server's words: "… Ask an admin if you need more").
  - provider, owner/admin: it comes back at <time>; to keep going now, connect another AI account in Admin › AI
    providers.
  - provider, member: it comes back at <time>; wait until then, or tell an admin.
- The server's stored words for `usage_used_up` (role-blind, read by Slack, rooms, notifications) become the member's
  words; the old sentence stays in the legacy list so stored answers still match.
- en.ts first, then ko, id, ja, es, zh.
- Often asked: one AI call per language people read the app in (the team's default and each member's own choice), only
  for a language that 3+ people typed lines in; each call writes in that language; a sentence is kept for a language
  only when it is written in its script; the checks stay as they are (fail closed). Home reads the list of the
  caller's own language and never another language's (old rows without a language are the team default's).
- Phones: the row of chips keeps its pattern (one row that scrolls sideways with an edge fade), checked at 390 px.

Out: translating suggestions across languages (a translated word is not one people typed, so the word check cannot
hold it), other surfaces' limit words (the composer's own budget notice is unchanged).

## Steps

1. This plan.
2. Usage limit: `usageLimitOf` + `chatErrorText` by cause, Messages.tsx reads it; i18n keys; server words; tests.
3. Often asked: migration 454 (`often_asked_items.locale`), per-language run and read; tests.
4. Phone row at 390 px: screenshots before/after under the scratchpad.
5. changes/usage-limit-notice-home-chips.md; decision file for the often-asked language.

## Decisions

- docs/decisions/20261125-often-asked-reader-language.md: amends "Home: what my group often asks" (sentences in the
  team's language for everyone) to the reader's language.

## Risks

Migration number (453 is taken by open PR #586; this takes 454). The word checks must not loosen. Five languages.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/b-often-asked*.test.ts, tests/unit/b-usage-used-up.test.ts,
web/test/unit/chat-error-words.test.ts, web often-asked tests.

## Result

(at the end)
