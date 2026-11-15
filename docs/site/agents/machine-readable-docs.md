---
title: Machine-readable docs
description: llms.txt, llms-full.txt and a Markdown copy of every page, for AI agents that read these docs.
---

These docs are built for people and for AI agents. Every page has a plain Markdown copy.

| What | Where | Use it for |
|---|---|---|
| `llms.txt` | `/llms.txt` on the docs site | An index of every page with a one-line description |
| `llms-full.txt` | `/llms-full.txt` | Every page in one file |
| Page Markdown | Add `.md` to a page address, for example `/get-started/quickstart.md` | One page, without the site around it |
| Source | `docs/site/` in the repository | Edit the docs |

Each page has a **Copy page** button. Its menu also has **View as Markdown** and **Copy llms.txt link**.

The user guide (Getting started and Use Trina AX) is also in Simplified Chinese under `/zh/`, with its own `zh/llms.txt`, `zh/llms-full.txt` and Markdown copies. Its source is `docs/site/zh/`: the same file names, a `nav.json` with translated titles, and the app's Chinese labels from `web/src/i18n/zh.ts`. A page with a Chinese twin names it with `hreflang` and has a link to it. The other pages are English only; the Chinese navigation marks them （英文）.

## Format of llms.txt

```text
# Trina AX Docs

> How to use, run, build on and automate Trina AX ...

## Root URL
...

### Getting started
- [Intro to Trina AX](/index.md) - Trina AX puts Claude Code and Codex on one company server ...
```

## For agents in the repository

The repository root also has a short [`llms.txt`](../../../llms.txt) for the product, and [`CLAUDE.md`](../../../CLAUDE.md) and [`AGENTS.md`](../../../AGENTS.md) for coding agents.

## Build the docs

```sh
bun run docs:build        # writes dist/docs-site/
```

`bun run docs:api` regenerates the [HTTP API reference](../reference/http-api.md) from the API contract. A unit test fails when it is out of date.

The screenshots in `docs/site/images/` (the Chinese pages' own in `docs/site/images/zh/`) come from made-up data. Refresh them after a UI change with one command:

```sh
bun run build:native && bun run build:web   # once per worktree
bun run docs:reshoot                        # --lang en|zh, --only chats, --keep
```

It starts the fictional Acme company (`bun run demo:company`, filled by `scripts/docs/acme-scene.ts`, with real answers from this computer's Claude Code sign-in) and the quickstart's demo on free ports, signs in through the form, takes every shot in English and in Simplified Chinese (light theme, 1440×900 or a 390×844 phone, 2× pixels, no development banner), writes WebP files, then stops both servers and deletes their data. `bun run docs:screenshots` takes one set from a server you started yourself; the Slack and Google pages' shots come from the web e2e mock server with `--mock`.
