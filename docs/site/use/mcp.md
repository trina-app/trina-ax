---
title: MCP connections
description: Let the AI use outside services such as Notion and Linear, with a person's or the team's own sign-in.
---

An MCP connection lets the AI use a service outside the team server. The AI uses the service's tools with the credentials of the connection.

:::note
Before 0.4.0, this screen is called **External services**.
:::

## Two kinds of connection

| Kind | What you give | What the AI gets |
|---|---|---|
| **MCP server** | The server's address; sign in or enter a key | The tools the server lists |
| **HTTP API with a key** | An address, a key and a note on how to use it | One tool, `api_request`, limited to addresses under that one |

## Personal and team connections

| | Personal | Team |
|---|---|---|
| Made by | The member, in **Settings › MCP** | An admin, in **Admin › MCP** |
| Used by | That member, in their own chats | The people its rules name: everyone, groups or people |
| Visible to | Only that member, not admins | Admins |

Admins manage team connections but do not use them unless a rule names them. Who may use a connection is checked on every call.

## Add a connection

:::steps
#### Open the MCP screen
**Settings › MCP** for yourself, or **Admin › MCP** for the team.

![Settings › MCP: no MCP connected yet, with Discover under it on the same page, and an Add connection button](../images/mcp/connected.webp "Settings › MCP")

#### Pick a service or add by address
**Discover**, under your connections on the same page, lists services that support sign-in with Trina AX. **Add connection** takes any MCP server address.

![Discover: MCP servers ready to add, such as Notion, Linear, Atlassian, Canva and Figma, each with a + button](../images/mcp/discover.webp "Discover: services you can add by name")

#### Sign in or paste a key
Keys and sign-ins are stored encrypted on the server and never shown again.

![The Add Notion dialog: the address filled in, Advanced folded with MCP server, sign-in and Ask every time, and Save and sign in](../images/mcp/add.webp "Adding a service from Discover")

#### Choose who may use it
For a team connection, name everyone, groups or people.
:::

You can also ask in a chat: "Connect Linear." The AI starts the connection, and you only sign in or paste the key into a sealed card.

## Changes need a yes

Reads run at once. Everything else is a write, and follows the connection's write policy:

| Policy | What happens |
|---|---|
| **Ask** (default) | The server shows a card with everything that will be sent. Nothing goes until a person says yes. |
| **Deny** | Writes are refused. |
| **Allow** | Writes run without asking. Only admins can choose this, and only for team connections. |

What a service returns is treated as outside data, never as instructions. In a scheduled run nobody can say yes, so writes are refused, except to an **Allow** team connection approved for that schedule.

## Templates: each member uses their own key

Many services give a key its owner's rights and log every call under that person's name. For those, an admin can add a **template** instead of a team connection: the service is registered once, and each member connects it with their own key or sign-in.

:::steps
#### Add a template
In **Admin › MCP**, choose **Add connection** (or a Discover card's **+**), then **Template: each member connects their own**. Fill in the address, the sign-in method and who it is for. There is no key field, and the address can't have a query (`?…`): a key there would reach every member.

#### Members connect
The members it is for see it in **Settings › MCP** under **From your team**, and choose **Connect**. They enter their own key or sign in. It becomes their own connection, used only in their chats.
:::

| | Team connection (one key) | Template |
|---|---|---|
| Key | One, added by the admin | Each member's own |
| Whose rights the AI uses | The key owner's, for everyone | Each member's own |
| What the admin sees | The connection | Who connected it and when, and whose key stopped working; never a key |

The people it is for get a notice in their **Inbox** that opens its **Connect**. In a chat, the AI offers a card to connect your own key when you ask for that service. On the template's line in Admin › MCP, **N connected** shows who it is for: **Connected** (with the date), **Not connected** or **Key stopped working**. A scheduled task that needs a template doesn't run without your own key: its result says "Needs your own key for …" and links to **Connect**.

A member can change only their key or sign-in and the write rule, and can disconnect at any time. If the admin changes a template's address or sign-in method, every member's key is deleted and they connect again; a new name or note keeps everyone connected. If a template changes while a member is connecting, they're asked to check it and connect again. Deleting the template, or removing someone from it, deletes their connections.

## Ask a member to connect

Some services log calls as the key's owner. Then the key belongs in the member's own connection. An admin can send a member a request with the service filled in. The member connects with their own key, or declines.

## The other direction

Your own Claude (Claude Code, Claude Desktop or claude.ai) can connect **to** Trina AX as an MCP server, and use your files with your permissions. [Read about the Team AX MCP connector](../agents/mcp-connector.md).

Full details: [Integrations](../../INTEGRATIONS.md).
