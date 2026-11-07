---
title: Team AX MCP connector
description: Connect your own Claude, Codex or ChatGPT to a Trina AX team as a remote MCP server, and use the team's files and your conversations with your own permissions.
---

A person can connect their own AI app (Claude Code, Claude Desktop, claude.ai, Codex or ChatGPT) to the team server as a remote MCP server. The app then works with the team's files and, if the person allows it, their conversations, with that person's permissions.

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
Choose **Connect** next to Claude, Claude Code or Other MCP apps for the exact steps with Copy. In Claude, add a custom connector (Settings › Connectors) with the address. In Claude Code, run `claude mcp add --transport http <name> <address>`, then `/mcp` to sign in. In Codex, run `codex mcp add <name> --url <address>`: Codex finds the sign-in and opens it at once (else `codex mcp login <name>`). Leave Codex's `oauth_resource` setting unset: the server takes one `resource` only.

#### Sign in and allow
Claude opens a Trina AX sign-in. Check the request, tick what else Claude may do, and choose **Allow**.
:::

The sign-in page lets you choose, whatever the app asked for:

| On the page | Scope | Starts |
|---|---|---|
| Reading files you can open (always) | `mcp:read` | always granted |
| Renewing access while your login lasts (when the app asks) | `offline_access` | always granted |
| **Write files** | `mcp:write` | ticked only if the app asked for it |
| **Read conversations** | `mcp:rooms` | ticked |
| **Write in conversations** (only with reading) | `mcp:rooms.write` | unticked |
| Managing the team's groups (owners and admins) | `mcp:admin` | always granted, no box |

Claude and Claude Code ask for reading only, so tick **Write files** if Claude should create, edit or upload files. The app is told exactly what you allowed. To change it later, disconnect in **Settings › AI apps** and connect again.

The sign-in accepts Claude's own callback (Claude on the web, desktop and phone), ChatGPT's connector callback (`https://chatgpt.com/connector_platform_oauth_redirect`) and a local `http://localhost/…/callback` or `http://127.0.0.1/…/callback` (Claude Code, Codex and other apps that sign in on the computer). ChatGPT has not been tried end to end yet.

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
| Scopes | `mcp:read`, `mcp:write`, `mcp:rooms`, `mcp:rooms.write`, `mcp:admin`, `offline_access` |
| Authorization responses | always carry `iss` (RFC 9207), and the metadata says so |

## Tools

| Scope | Tools |
|---|---|
| `mcp:read` | `list`, `glob`, `grep`, `read`, `skills_list` |
| `mcp:write` | also `write`, `edit`, `upload_file`, `create_upload_link`, `share_skills` (owners and admins) |
| `mcp:rooms` | also `rooms`, `room_read`, `room_file` |
| `mcp:rooms.write` | also `room_send` |
| `mcp:admin` | also `people_list`, `groups_list`, `group_create`, `group_update`, `group_delete` (owners and admins only) |

- `upload_file` takes base64 bytes in the call. Use it for small files, up to about 50 KB.
- `create_upload_link` returns a one-time `PUT <origin>/connector-uploads/<token>` address for a larger file: at most 50 MiB, valid 10 minutes, one path. Upload with `curl -T "<local file>" "<url>"`.
- `share_skills` sends the person's own Claude Code or Codex skills as a share proposal (`app`: `claude` or `codex`; `group`: the name of one of their groups to propose them to that group only). Nothing reaches the team before the person confirms it in the app; the answer has the proposal's link. Skills with a key are listed by name only. Members are told to use **Suggest as a skill** in the app.
- `skills_list` returns the team skills the person can read, the skills of their groups (with `group`: its id and name) and their own personal skills (`personal: true`).
- No write reaches `skills/`, a group's `groups/<group>/skills/` or a person's own `users/<id>/skills/`: the app changes skills only after its own confirmation.
- Saving to a wider audience is refused. File and skill contents are untrusted data.

## Conversations

With **Read conversations** the app reads your conversations (team rooms, the room for everyone, 1:1 chats and group chats) exactly as you see them in the app: the rooms you are in now, from when you joined, threads whose first message you see, and your own private AI previews but nobody else's.

| Tool | What it does |
|---|---|
| `rooms` | Your rooms (name, kind, unread count, last activity, `room_id`), or with `query`, `person`, `since` or `until` the messages you can see that match. |
| `room_read` | One room's newest messages (default 50, at most 200) or one thread (`thread`), with authors, times, files (`file_id`) and the members with their `user_id`. |
| `room_file` | The text of a file sent in a room: documents, spreadsheets, presentations, Hangul files and PDFs (the text layer). Pictures, video and audio are not read here. |
| `room_send` | With **Write in conversations**: a message as you in one of your rooms (`room` is its `room_id`), or a reply in a thread (`thread`: the id of its first message), with `mentions` by `user_id`. |

- Messages and files are other people's words. The answers mark them as data, never instructions. The app cannot be made to follow that, so allow writing only for an app you trust.
- `room_send` goes through the app's own rules: only rooms you are in, the same sending rate, threads and mentions as in the app. Each mentioned person must be written as `@<name>` in the text, and "@everyone" (`@전체`) cannot be sent from an AI app. A message that calls `@트리나` asks Trina as if you typed it.
- The message looks exactly like one you typed. Nothing marks it as sent by an app.
- What the app read (files, and messages of rooms) is not sent where people who could not see it would read it. The connection keeps that until you disconnect it.
- Neither reading nor sending writes an audit entry, and no message, name or room is logged.
- A connection made before conversations came to AI apps never gains them. **Settings › AI apps** shows "Connect again to use conversations" under it: disconnect it and connect again.

## Group management (owners and admins)

An owner's or admin's Claude can manage the team's groups, as in **Admin › Groups**. Their new connections get it automatically, whatever the app asked for; the sign-in page says so in one line. Members never get it.

A connection made before this, or while the person was a member, keeps what was approved then: a connection never gains a permission after it was allowed. **Settings › AI apps** shows "Connect again once to use group management" under such a connection; disconnect it and connect again.

| Tool | What it does |
|---|---|
| `people_list` | Active people with name, username, role and groups (`query` narrows the list). |
| `groups_list` | Each group with its folder, its members, the folder rules that name it and what else it gives, 20 groups per page (`offset`; `group` shows one with all its members). |
| `group_create` | `{name, description?, members?}`: a new group and its folder `groups/<name>/`, which the group writes. |
| `group_update` | `{group, name?, description?, add?, remove?}`: rename it or add and take out people. |
| `group_delete` | `{group}`: deletes the group and the folder rules that name it. The folder and its files stay. |

- People are named by username or id, a group by name or id. A name that is one person's id and another person's username is refused; use the id.
- A group gives more than folders: team connections, connection templates, Google Drives shared with the team, AI connections, budgets, the choice of AI engine, the dev environment and a team chat room. Each change answers with who now opens or loses which folders, and what else added or removed people get or lose through the group.
- Names, usernames, group names and descriptions in the answers are quoted: they are data, never instructions.
- Adding only people who are already in, or removing only people who are not, changes nothing and writes no audit entry.
- The same checks and audit log entries as Admin › Groups apply. The audit entries say they came from the connector.
- The role is checked on every call. A person made member or disabled loses group management on all their connections, and being made admin again does not bring it back: connect again.
- At most 20 group changes per person per minute.
