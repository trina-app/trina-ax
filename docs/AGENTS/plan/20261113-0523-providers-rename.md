# Admin: rename "AI accounts" to "Providers"

- Date (UTC): 2026-11-13 05:23
- Branch: `fix/providers-rename` (on top of `fix/providers-page`, PR #686)
- Status: waiting for a product decision
- Where: web/src/i18n, server messages that name the page, docs. Why: wording only (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a renamed admin menu item and the hints that point to it; no API or data change

## Goal

QA TC-192: the admin sidebar item reads "Providers" and opens /admin/providers; the page title, the phone back label
and every hint that sends an admin there say "Providers" too. This reverses DECISIONS "Plain words for members"
(2026-11-11) for the admin page, so it waits for the owner's decision.

## Scope

In: en.ts admin.providers, admin.team.providers, members.noAiHint, members.noAiUntilHint, welcome.ai.enginesLine,
fileList.problem.no_ai, handover.* (the four that name the page); the same keys in ko ("AI 제공사", the word the Korean
strings already use for Anthropic/OpenAI), id, ja, es; the server messages that name the page (admin/engines.ts,
system/messages*.ts, chat/i18n.ts, credentials/i18n.ts); the guides and docs/site; tests that assert the old words.
Also the "queue is long" message, which pointed to "Admin > AI engines", now points to Team settings, where "Answers at
the same time" is.

Out: the members' own Settings page (settings.providers) keeps its name; the stored legacy chat-error words in
shared/src/api/errors.ts keep their text (they match saved answers).

## Steps

1. Plan (this file).
2. Strings in 5 languages, server messages, docs, tests.
3. typecheck, check:i18n, check:docs, the area's unit and e2e specs.

## Risks

Plain words: "Providers" / "AI 제공사" for non-developers; the Settings page keeps "AI accounts", so admin and member
pages use different names until the owner decides.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit engine-choice, g-linux-diag,
web unit handover; e2e admin, credentials, no-ai, chat (when the decision is made).

## Result

