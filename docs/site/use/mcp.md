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
| Made by | The member, in **Settings › Connectors** (from Discover; by address only owners and admins) | An admin, in **Admin › Connected apps** |
| Used by | That member, in their own chats | The people its rules name: everyone, groups or people |
| Visible to | Only that member, not admins | Admins |

In **Settings › Connectors**, the team connections you may use are listed in **Your connectors** with a **Team** label and one
status each. Each opens its own page, read only.

Admins manage team connections but do not use them unless a rule names them. Who may use a connection is checked on every call.

Google Drive, Gmail, Google Calendar, Google Docs and Google Sheets are built-in Google apps in the same lists. A company on Google Workspace can have them sign in with its own Google app: [Use your company's own Google app](google-own-app.md).

## Add a connection

:::steps
#### Open Connectors or Connected apps
**Settings › Connectors** for yourself (your photo at the bottom of the bar on the left › **Settings**; on a phone the **Me**
tab), or **Admin › Connected apps** for the team. Earlier versions had Connectors in the list of Trina chats.

![Connectors: nothing connected yet, with Discover under it on the same page](../images/mcp/connected.webp "Connectors")

#### Pick a service or add by address
**Discover**, under your connections on the same page, lists services that support sign-in with Trina AX. Owners and admins can also add any MCP server or API by its address (**Add**, or "Not listed? Add one by its address"). A member reads "Not listed? Ask an admin to add it.": the admin adds it for the team, or asks the member to connect it with their own account (below).


#### Sign in or paste a key
Keys and sign-ins are stored encrypted on the server and never shown again.

![The Add Notion dialog: the address filled in, Advanced folded, and Save and sign in](../images/mcp/add.webp "Adding a service from Discover")

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
In **Admin › Connected apps**, choose **Add** (or a Discover card's **+**), then under **Who connects** pick **Each member's own**. Fill in the address, the sign-in method and who it is for. There is no key field, and the address can't have a query (`?…`): a key there would reach every member.

#### Members connect
The members it is for see it in **Settings › Connectors** under **Your connectors**, with a **Team** label, and choose **Connect**. They enter their own key or sign in. It becomes their own connection, used only in their chats.
:::

| | Team connection (one key) | Template |
|---|---|---|
| Key | One, added by the admin | Each member's own |
| Whose rights the AI uses | The key owner's, for everyone | Each member's own |
| What the admin sees | The connection | Who connected it and when, and whose key stopped working; never a key |

The people it is for get a notice in **Activity** that opens its **Connect**. In a chat, the AI offers a card to connect your own key when you ask for that service. On the template's line in Admin › Connected apps, **N connected** shows who it is for: **Connected** (with the date), **Not connected** or **Key stopped working**. A scheduled task that needs a template doesn't run without your own key: its result says "Needs your own key for …" and links to **Connect**.

A member can change only their key or sign-in and the write rule, and can disconnect at any time. If the admin changes a template's address or sign-in method, every member's key is deleted and they connect again; a new name or note keeps everyone connected. If a template changes while a member is connecting, they're asked to check it and connect again. Deleting the template, or removing someone from it, deletes their connections.

## Ask a member to connect

Some services log calls as the key's owner. Then the key belongs in the member's own connection. An admin can send a member a request with the service filled in. The member connects with their own key, or declines.

## The other direction

Your own Claude (Claude Code, Claude Desktop or claude.ai) can connect **to** Trina AX as an MCP server, and use your files with your permissions. [Read about the Team AX MCP connector](../agents/mcp-connector.md).

Full details: [Integrations](../../INTEGRATIONS.md).
