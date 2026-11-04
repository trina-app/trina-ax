---
title: Repository layout
description: Where each part of Trina AX lives in the repository, and where to make a change.
---

The repository is a Bun workspace. The product id in code is `mycel`.

## Top-level folders

| Folder | What is in it |
|---|---|
| `server/` | The team server: routes, chat and turns, files, permissions, engines, tools, integrations, admin |
| `web/` | The browser app (React), its unit tests, Playwright e2e tests and a mock server |
| `shared/` | Code used by server and clients: the HTTP API contract, ids, product and release-channel settings |
| `native/` | Go programs for the sandbox, the tool gate, the launcher and `mycel-ctl` |
| `relay/` | The public-address relay |
| `desktop/`, `mobile/`, `menubar/` | The Windows/Mac desktop app, the mobile wrapper and the server Mac's menubar app |
| `tests/` | Unit, security, fuzz, Linux, relay and engine tests |
| `scripts/` | Dev server, demo, builds, release and checks |
| `editions/trina/branding/` | Trina branding, applied at build time |
| `examples/` | Starter skills with fictional inputs |
| `docs/` | Guides, decisions and this documentation site (`docs/site/`) |

## Inside the server

| Folder | Area |
|---|---|
| `server/src/routes/` | HTTP routes, one file per area |
| `server/src/chat/` | Chats, turns, skills and the AI's instructions |
| `server/src/engine/` | Running Claude Code, Codex and the API engine |
| `server/src/tools/` | Server tools: search, web, save_url, make_file, schedules and more |
| `server/src/files/`, `server/src/team-files/` | File service and the team folder |
| `server/src/policy/` | The permission function |
| `server/src/integrations/` | MCP and HTTP API connections |
| `server/src/connectors/remote-mcp/` | The Team AX MCP connector for outside AI apps |
| `server/src/proxy/` | The model proxy |
| `server/src/admin/` | Admin features, audit and usage |
| `server/migrations/` | SQL migrations |

## Where to make a change

| You want to | Start in |
|---|---|
| Add or change an endpoint | `shared/src/api/<area>.ts`, then `server/src/routes/<area>.ts` |
| Change a screen | `web/src/pages/` and `web/src/components/` |
| Add a string | `web/src/i18n/{en,ko,id,es,ja}.ts` |
| Add an AI tool | `server/src/tools/` and its registry |
| Change who can see what | `server/src/policy/` (read the [decisions](../../DECISIONS.md) first) |

Design decisions are recorded in [`docs/DECISIONS.md`](../../DECISIONS.md). Ownership by area is in [`docs/WORKPLAN.md`](../../WORKPLAN.md).
