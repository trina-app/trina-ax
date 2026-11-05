---
title: Team AX MCP connector
description: Connect your own Claude to a Trina AX team as a remote MCP server, and use the team's files with your own permissions.
---

A person can connect their own Claude (Claude Code, Claude Desktop or claude.ai) to the team server as a remote MCP server. Claude then works with the team's files, with that person's permissions.

:::note
This is the opposite direction from [MCP connections](../use/mcp.md), where Trina's AI uses outside services.
:::

## Turn it on (operator)

The connector is off until the server has a public HTTPS address for it. Use one of:

| Setup | How |
|---|---|
| Linux installer | `--public-host HOST --app-connectors` |
| `server.json` | `appConnectors: true` with `tunnel.host` |
| Environment | `MYCEL_REMOTE_MCP_ORIGIN=https://team.example.com` (wins when set) |

## Connect (each person)

:::steps
#### Copy the connector address
Open **Settings › App connectors**. It shows the connector address, which ends in `/mcp`.

#### Add it to Claude
Add a custom connector or remote MCP server in your Claude app with that address.

#### Sign in and allow
Claude opens a Trina AX sign-in. Check the request and choose **Allow**.
:::

**Settings › App connectors** lists your connected apps, with **Disconnect**. A connection also ends when the app session that authorized it ends.

The same list starts with **Google Drive**: your own Google account, which Trina's AI can search and read (the other
direction: [Google Drive setup](https://github.com/trina-app/trina-ax/blob/main/docs/GOOGLE-DRIVE.md)). Admins see
whether this server offers each connector in **Admin › App connectors**.

## Protocol

| Item | Value |
|---|---|
| MCP endpoint | `<origin>/mcp` (Streamable HTTP) |
| OAuth discovery | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` |
| OAuth endpoints | `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` |
| Client registration | Dynamic (RFC 7591), public clients, PKCE `S256` |
| Scopes | `mcp:read`, `mcp:write`, `offline_access` |

## Tools

| Scope | Tools |
|---|---|
| `mcp:read` | `list`, `glob`, `grep`, `read`, `skills_list` |
| `mcp:write` | also `write`, `edit`, `upload_file`, `create_upload_link` |

- `upload_file` takes base64 bytes in the call. Use it for small files, up to about 50 KB.
- `create_upload_link` returns a one-time `PUT <origin>/connector-uploads/<token>` address for a larger file: at most 50 MiB, valid 10 minutes, one path. Upload with `curl -T "<local file>" "<url>"`.
- Saving to a wider audience is refused. File and skill contents are untrusted data.
