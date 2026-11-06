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
Open **Settings › AI apps**. It shows the connector address, which ends in `/mcp`.

#### Add it to Claude
Choose **Connect** next to Claude, Claude Code or Other MCP apps for the exact steps with Copy. In Claude, add a custom connector (Settings › Connectors) with the address. In Claude Code, run `claude mcp add --transport http <name> <address>`, then `/mcp` to sign in.

#### Sign in and allow
Claude opens a Trina AX sign-in. Check the request, tick what else Claude may do, and choose **Allow**.
:::

The sign-in page lets you choose, whatever the app asked for:

| On the page | Scope | Starts |
|---|---|---|
| Reading files you can open (always) | `mcp:read` | always granted |
| Renewing access while your login lasts (when the app asks) | `offline_access` | always granted |
| **Write files** | `mcp:write` | ticked only if the app asked for it |
| **Manage groups** (owners and admins only) | `mcp:admin` | unticked |

Claude and Claude Code ask for reading only, so tick **Write files** if Claude should create, edit or upload files. The app is told exactly what you allowed. To change it later, disconnect in **Settings › AI apps** and connect again.

The sign-in accepts Claude's own callback (Claude on the web, desktop and phone) and a local `http://localhost/…/callback` (Claude Code and other apps that sign in on the computer). An app that signs in through its own website, such as ChatGPT, cannot connect yet.

**Settings › AI apps** lists your connected apps, with when they connected and **Disconnect**. A connection also ends when the app session that authorized it ends.

Admins see whether this server's connector is on in **Admin › AI apps**. The other direction, apps Trina's AI uses with
your own account such as **Google Drive**, is **Settings › App connectors** ([Google Drive setup](https://github.com/trina-app/trina-ax/blob/main/docs/GOOGLE-DRIVE.md)).

## Protocol

| Item | Value |
|---|---|
| MCP endpoint | `<origin>/mcp` (Streamable HTTP) |
| OAuth discovery | `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` |
| OAuth endpoints | `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` |
| Client registration | Dynamic (RFC 7591), public clients, PKCE `S256` |
| Scopes | `mcp:read`, `mcp:write`, `mcp:admin`, `offline_access` |

## Tools

| Scope | Tools |
|---|---|
| `mcp:read` | `list`, `glob`, `grep`, `read`, `skills_list` |
| `mcp:write` | also `write`, `edit`, `upload_file`, `create_upload_link` |
| `mcp:admin` | also `people_list`, `groups_list`, `group_create`, `group_update`, `group_delete` (owners and admins only) |

- `upload_file` takes base64 bytes in the call. Use it for small files, up to about 50 KB.
- `create_upload_link` returns a one-time `PUT <origin>/connector-uploads/<token>` address for a larger file: at most 50 MiB, valid 10 minutes, one path. Upload with `curl -T "<local file>" "<url>"`.
- Saving to a wider audience is refused. File and skill contents are untrusted data.

## Group management (owners and admins)

An owner or admin can let their Claude manage the team's groups, as in **Admin › Groups**. The sign-in page shows **Manage groups** to owners and admins, unticked, whatever the app asked for. Members never see it and never get the scope.

| Tool | What it does |
|---|---|
| `people_list` | Active people with name, username, role and groups (`query` narrows the list). |
| `groups_list` | Each group with its folder, its members and the folder rules that name it (`group` shows one). |
| `group_create` | `{name, description?, members?}`: a new group and its folder `groups/<name>/`, which the group writes. |
| `group_update` | `{group, name?, description?, add?, remove?}`: rename it or add and take out people. |
| `group_delete` | `{group}`: deletes the group and the folder rules that name it. The folder and its files stay. |

- People are named by username or id, a group by name or id.
- Each change answers with who now opens or loses which folders.
- The same checks and audit log entries as Admin › Groups apply. The audit entries say they came from the connector.
- The role is checked on every call. A person made member or disabled loses group management on all their connections, and being made admin again does not bring it back: connect again and tick the box.
- At most 20 group changes per person per minute.
