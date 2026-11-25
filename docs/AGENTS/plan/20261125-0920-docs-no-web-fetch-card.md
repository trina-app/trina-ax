# The AI answers from trina_docs without fetching the docs page, and the docs page needs no card

- Date (UTC): 2026-11-25 09:20
- Branch: `fix/docs-no-web-fetch-card`
- Status: done
- Where: server/src/docs-help/, server/src/tools/url-gate.ts. Why: the docs tool and the web address card live there
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a fix to how an existing tool answers; no new feature, setting or API.
- QA: TC-9174

## Goal

Since #535 the AI answers app questions from `trina_docs` and ends with the page's link. In 5 of 8 real-AI doc
questions on qa it then also called `web_fetch` on that page (ax.trina.app/docs/...), which raised the "check this
address doesn't contain your information" card with the all-sites offer. Declining still gave a full answer: the fetch
is redundant and the card is noise.

## Scope

In:
- (a) The `trina_docs` result says its passages are the docs' own text, so the AI does not open the link; the
  instructions' line says the same in a few words (the size test still holds).
- (b) `web_fetch` of a page of the app's own public docs, exactly a page address the docs tool links to (the server's
  help index: every language's page URLs, which carry the docs base), opens with no card: https, no query, no user
  name, any `#fragment` ignored, a trailing `/` either way. Not in a confidential chat. Every other address keeps its
  card as before; other trina.app hosts and other paths on ax.trina.app (pricing, the site) are not covered.

Out: the in-app browser pane and save_url (same gate, but not the reported case: they keep their cards).

## Steps

1. docs-help: `isDocsPage(url)` over the help index's page URLs; result and rule wording.
2. url-gate: `gateUrl(..., { docs: true })` returns `'docs'` for such a page; web_fetch passes `docs: true`.
3. Unit tests: docs-help wording, gate opens docs pages with no card, keeps the card for near misses.
4. Real-AI measurement on a local server: 8 doc questions (ko + en), cards before and after.

## Decisions

`docs/decisions/20261125-docs-no-web-fetch-card.md`.

## Risks

Security: a fetch of a fixed public page we publish carries nothing out (the address is one of a known list, so no data
can ride in the path or query). No migration. No UI text.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/docs-help.test.ts, the new gate test, url-gate tests.

## Result

Built as planned (url-gate rule ①e, `isDocsPage` over the help index's page addresses, the result and rule wording).

Real AI on two local servers (this Mac's Claude sign-in, the ai-scenarios fixture, person 이소라, every card declined
as on qa), origin/dev (a6c9e644c) against this branch, 16 doc questions each:

| Set | origin/dev: web_fetch of the docs / cards | this branch: web_fetch / cards |
|---|---|---|
| 8 short questions (4 ko, 4 en: Slack, invite, schedule, Drive, guest, usage limit, folder share) | 0 / 0 | 0 / 0 |
| 8 "step by step / from the docs" questions (4 ko, 4 en: Gmail blocked, AI account reconnect, Notion, Linux install, API key, Google Forms) | **8 / 8** | **0 / 0** |

On origin/dev, after the declined card the answers of the second set were short (61–303 characters, 2 of 8 with the
link); on this branch they were full answers from the docs (481–2,153 characters, 8 of 8 with the link). The one other
card on origin/dev (the schedule question: the AI started making a scheduled task) is not an address card.
