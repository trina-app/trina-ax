# The AI answers questions about the app from its own docs, with a link (trina_docs)

- Date (UTC): 2026-11-24 12:03
- Branch: `feat/trina-docs-tool`
- Status: in progress
- Where: server/src/docs-help/ (data, search, tool), server/src/chat/tools.ts and prompt.ts (offer and one line),
  scripts/docs/ (the data from the docs build), scripts/build-bundle.ts and scripts/build-office.ts (into every server
  bundle). Why: it is the chat's AI and the server release; nothing of it is customer- or edition-operations code (see
  docs/REPOSITORY-RULES.md)
- Version impact: minor, a new AI capability (a new tool and a new resource in the server bundle); no API, data or
  setting change

## Goal

Step 1 of the setup helper plan (owner, 2026-11-24): asked how to use, set up or fix the app ("how do I connect
Slack?", "the AI does not answer"), the AI answers from the app's own docs (docs/site, six languages) and ends with the
link to the page, in the person's language. The docs ship with the server, so the installed version and its docs
match, hosted or self-hosted, and nothing is fetched from the internet at answer time.

## Scope

In:
- The docs build (scripts/docs/build.ts) gives the server its data: per language, every page's title, description,
  public URL and its sections (h2/h3) as plain text, from the same renderers as the site. The generated API reference
  (reference/http-api) is left out (a list of endpoints, 130 KB, no prose). A language's untranslated pages get a small
  entry with that language's tab and group names, so a Korean "설치" still finds the English install page.
- Every server bundle carries it at `resources/docs/help-index.json` in the version folder (macOS bundle, Linux bundle
  and kit, so Docker and hosted servers too, office zip); the bundle checks list it. A source checkout builds the same
  data in memory from docs/site on first use.
- `trina_docs(query)`: a local search (BM25 over sections; words for Latin script, character pairs for Hangul and
  Han/kana; a few Hangul spellings of product names) in the person's language first, then English; up to 3 pages, each
  with its title, the best short passage (at most about 300 characters) and the page's public URL in the person's
  language, else English. Nothing leaves the server. Offered in the person's own chat, a shared chat, a confidential
  chat (a local tool), to sub-agents (read-only, also the Explore helper) and in a scheduled run; not to a guest (as the
  app map), not in the drafts and judges that have no tools.
- One line in the instructions where the tool is offered: questions about using, setting up or troubleshooting the
  app → search with trina_docs first, end with the page's link; pricing → the pricing page.
- An evaluation: 20 frequent questions in Korean and English, each with the page it should find; a unit test asserts
  that page is in the top 3 for all 40.
- Docs: a decision file, changes/ note, the docs page "Chats and projects" (six languages) says the AI answers from the
  docs.

Out: the external knowledge base / `howto` (postponed by the owner, 2026-11-24); the remote MCP connector (no chat
turn); section anchors in the links; a per-version docs site.

## Steps

1. This plan (first commit).
2. scripts/docs: export the per-language help data from the docs build; a stage function writes it into a bundle.
3. Bundles: macOS, Linux (and its file list), office (and its manifest) call the stage function.
4. server/src/docs-help: load (bundle file, else build from docs/site), search, the tool's text.
5. chat/tools.ts offers it (guests no); LOCAL_TOOLS, SHARED_TOOLS, READ_ONLY_TOOLS, FREE_ROAM_TOOLS, step label;
   prompt.ts line.
6. Tests: the 40 questions; tool lists (i-wiring and the others); the bundle file; the size of the line and schema.
7. Decision, changes note, docs page, measure bundle size and the schema's tokens.

## Decisions

New: docs/decisions/20261124-trina-docs-tool.md (a help tool now, though the app map decisions rejected `where_is`:
what is different). Related: [app map](../../decisions/20261116-ai-app-map.md),
[five places](../../decisions/20261117-ai-app-map-five-places.md).

## Risks

- Per-turn cost: the tool's definition is in every request where it is offered; measured and kept small.
- Bundle size: about 2 MB of JSON before compression; measured in the PR.
- Wrong or stale answers: the docs are the version's own; the passage is short, and the link lets the person read on.
- No migration. No card (no ASKS.md entry). Five app languages: the step label in all of them.

## Tests

`bun run typecheck`, `bun run check:docs`, `bun run check:prepush`, unit tests: the new docs-help test, i-wiring,
c-tools, b-browser, step labels, demo free-roam, shared chats, confidential, sub-agents.

## Result

Filled in at the end.
