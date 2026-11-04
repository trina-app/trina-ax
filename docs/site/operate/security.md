---
title: Security and data flows
description: What the server checks, what leaves the server, and what Trina AX does not promise.
---

The same question can use an HR file only for a person allowed to read it. The server checks the asking person's access on every file request.

## Layers of protection

| Layer | What it does |
|---|---|
| **Permission check** | One server function decides every file access, as the person asking. |
| **Engine lockdown** | The engine's own shell and file tools are turned off. Its only path to your folders is Trina's file tools. |
| **OS isolation** | On Linux and role-account Macs, engines run as a separate OS account in a sandbox. |
| **Sealed keys** | Tokens are sealed in the browser before they are sent. The engine gets a per-turn stand-in, and the model proxy adds the real key. |
| **Confirmation** | Writing restricted content somewhere more people can see asks first. |

## What leaves the server

- Prompts, history and the file or tool content the AI needs go to the AI provider you connected. Images go too, unless an admin turns that off.
- MCP and HTTP connections receive their own requests.
- The server asks `https://updates.trina.app/ip` for its own public address every 30 minutes (`MYCEL_EXIT_ADDRESS_CHECK=off` stops it).
- Each Codex web search sends the conversation so far to OpenAI's search service.

Self-hosting is not offline. Hosting in AWS Seoul is where the team server runs, not where the AI provider processes data.

## Who can read what

- **Members** see their own chats and the folders the rules allow.
- **Admins** manage the team and see activity records, not other people's chats.
- **Server operators** can read stored files and chats. In hosted plans, that includes Trina's operators.

## What we do not promise

No security certification, no zero-leak guarantee and no universal data-loss prevention. Revoking access does not retract earlier answers. Review outputs before using them.

Report security problems privately: [Security policy](../../../SECURITY.md). Full details: [Security and permissions](../../security-and-permissions.md).
