---
title: Architecture
description: The pieces of Trina AX and how a question travels from the browser to the AI and back.
---

Trina AX is one server per team. People use it from a browser, a phone or the Windows app. The AI engines run on the same server, behind a permission check.

## The big picture

```text
 Browser · phone · Windows app
            │  HTTPS + WebSocket
            ▼
 ┌────────────────────────────────────────────┐
 │ Trina server  (Bun · Hono · SQLite)        │
 │  web app · HTTP API · turns · admin        │
 │                                            │
 │  ┌──────────────┐   tool calls   ┌──────────────────┐
 │  │ Engine       │ ─────────────▶ │ Permission check │
 │  │ Claude Code  │  mycel-bridge  │ as the person    │
 │  │ Codex · API  │  → mycel-gate  │ asking           │
 │  └──────────────┘                └────────┬─────────┘
 │         │ model calls                     ▼
 │         ▼                          Team folder
 │   Model proxy ──▶ AI provider      shared · groups · projects · skills · users
 └────────────────────────────────────────────┘
```

## A question, step by step

:::steps
#### The browser sends a turn
The web app sends the message over the WebSocket at `/api/ws`. The server queues it and starts an engine run.

#### The engine runs in a sandbox
The engine's own shell and file tools are off. On Linux it runs as a separate OS account, in its own cgroup, through `mycel-sandbox`.

#### Tools go through the gate
The engine calls Trina's tools over MCP. `mycel-bridge` forwards each call to `mycel-gate`, which hands it to the server's tool handler.

#### Every file call is checked
The server checks the call against the asking person's folder permissions, and records it.

#### The model proxy adds the key
The engine never holds the real API key. The model proxy adds it, counts usage and applies limits.

#### The answer streams back
Steps and text stream to the browser. Confirmation cards wait for a person.
:::

## Components

| Component | Folder | Built with |
|---|---|---|
| Server | `server/` | Bun, Hono, SQLite (`bun:sqlite`), zod |
| Web app | `web/` | React 19, Vite, Tailwind CSS 4 |
| API contract | `shared/src/api/` | zod schemas, one registry for server and clients |
| Native helpers | `native/` | Go: `mycel-ctl`, `mycel-sandbox`, `mycel-gate`, `mycel-bridge`, `mycel-launcher`, `mycel-bootstrap` and others |
| Relay | `relay/` | Node: public addresses through outbound WebSockets |
| Desktop app | `desktop/` | Electron, with an in-app browser the AI can drive |
| Mobile app | `mobile/` | Expo wrapper around the team's web app |
| Menubar app | `menubar/` | Swift, for the server Mac |

## The API contract

Every HTTP endpoint is declared once in `shared/src/api/`: method, path, who may call it, the body and the response, as zod schemas. The server validates against it, and the web app calls endpoints by name. [See every endpoint](../reference/http-api.md).

## Data on disk

| Path (Linux default) | Holds |
|---|---|
| `/var/lib/mycel/data` | The SQLite database, sessions, backups and private runtime files |
| The team root | The team folder: `shared/`, `groups/`, `projects/`, `skills/`, `users/` |
| `/var/lib/mycel/config/server.json` | Operator configuration |
| `/var/lib/mycel/app/` | The current app version and the previous one |

Database changes are SQL migrations in `server/migrations/`.
