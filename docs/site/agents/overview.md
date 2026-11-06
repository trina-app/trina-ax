---
title: Docs for AI agents
description: Two kinds of agent work with Trina AX. Coding agents change this repository, and runtime agents answer people inside a team.
---

AI agents meet Trina AX in two ways. Pick the page for yours.

| | Coding agents | Runtime agents |
|---|---|---|
| **Who** | Claude Code, Codex or another agent changing this repository | Claude Code, Codex or your own Claude, answering people in a team |
| **Works on** | Source code, tests and docs | The team folder, skills and connected services |
| **Bound by** | Repository rules and checks | The asking person's permissions, checked on every call |
| **Start here** | [Working in this repository](coding-agents.md) | [How AI works inside Trina AX](runtime.md) |

## For coding agents

:::cards cols=2
- icon=git-pull-request | [Working in this repository](coding-agents.md) | Rules, checks, pull request format and what never to commit.
- icon=file-text | [Machine-readable docs](machine-readable-docs.md) | `llms.txt`, `llms-full.txt` and a Markdown copy of every page.
:::

## For runtime agents

:::cards cols=2
- icon=cpu | [How AI works inside Trina AX](runtime.md) | Engines, tools, permissions, confirmations and limits.
- icon=plug | [Team AX MCP connector](mcp-connector.md) | Connect your own Claude to a team's files over MCP.
- icon=book-open | [SKILL.md format](skills-format.md) | The exact header and placement rules for skills.
- icon=package | [Plugins](plugins.md) | Skill bundles and isolated native tools, installed by admins.
:::
