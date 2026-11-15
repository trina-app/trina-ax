# Admin: rename "AI accounts" to "Providers"

- Date (UTC): 2026-11-15 07:32
- Branch: `fix/admin-providers-rename`
- Status: in progress
- Where: web/src/i18n, the server messages that name the admin page, docs and docs/site. Why: wording only (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch: a renamed admin menu item and the hints that point to it; no API or data change

## Goal

QA TC-192 (tracking TC-742): the admin sidebar item reads "Providers" and opens /admin/providers; the page title, the
phone's name for it and every hint that sends an owner or admin there say "Providers" too. Decided 2026-11-15: admin
side only (the scope recommended in closed draft #693). This reverses DECISIONS "Plain words for members"
(2026-11-11) for the admin page.

## Scope

In: en.ts `admin.providers`, `admin.team.providers` (the phone's name, was "Team AI accounts"), `members.noAiHint`,
`members.noAiUntilHint`, `welcome.ai.enginesLine`, `fileList.problem.no_ai`, the four `handover.*` strings; the same
keys in ko ("AI 제공사", the word the Korean strings already use for Anthropic/OpenAI), id, ja, es, zh; the server
messages that name the page (`system/messages*.ts`, `chat/i18n.ts`, `credentials/i18n.ts`; the Linux ones still say
"AI engines"); docs and docs/site pointers; tests that assert the old words. The "queue is long" message pointed to
"Admin > AI engines"; it points to Team settings, where "Answers at the same time" is now.

Out: the members' own Settings page (`settings.providers`, `settings › AI accounts`) keeps its name; the stored legacy
chat-error words in shared/src/api/errors.ts (they match saved answers); `server/src/admin/engines.ts` managedNone /
managedNoneDetail (the Codex "No AI connection" line on the page itself; another branch changes it now); code comments.

## Plain-words check

"Providers" / "AI 제공사" names who supplies the AI (Anthropic, OpenAI), a word office workers know from "통신 제공사";
it appears only to owners and admins. Members never see it: their page keeps "AI accounts".

## Steps

1. Plan (this file).
2. Strings in 6 languages, server messages, docs, tests.
3. typecheck, check:i18n, check:docs, the area's unit and e2e specs; screenshots 1440 and 390 before and after.

## Risks

Admin and Settings now use different names for related pages (on purpose: one is the team's, one is your own).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; tests/unit engine-choice, g-linux-diag, docs-site,
web unit handover, admin-back-names; e2e admin, credentials, no-ai, chat, phone-admin-system, phone-admin-pages.

## Result
