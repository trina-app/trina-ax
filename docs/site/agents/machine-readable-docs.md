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

Each page also has **Copy page** to copy its Markdown, and **View as Markdown**.

## Format of llms.txt

```text
# Trina AX docs

> How to use, run, build on and automate Trina AX ...

## Root URL
...

### Get started
- [Intro to Trina AX](/index.md) - Trina AX puts Claude Code and Codex on one company server ...
```

## For agents in the repository

The repository root also has a short [`llms.txt`](../../../llms.txt) for the product, and [`CLAUDE.md`](../../../CLAUDE.md) and [`AGENTS.md`](../../../AGENTS.md) for coding agents.

## Build the docs

```sh
bun run docs:build        # writes dist/docs-site/
```

`bun run docs:api` regenerates the [HTTP API reference](../reference/http-api.md) from the API contract. A unit test fails when it is out of date.
