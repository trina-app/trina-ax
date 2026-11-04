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

The screenshots in `docs/site/images/` come from a running server with made-up data. Refresh them after a UI change:

```sh
DOCS_SHOT_USER=dion DOCS_SHOT_PASSWORD=… bun run docs:screenshots --url https://team.example.com
```

It signs in through the form, uses the light theme at 1280×800 (2× pixels), hides the development banner and writes WebP files. `--only scheduled` refreshes one page's shots.
