---
title: Notion, Linear and other apps
description: Connect Notion, Linear, Atlassian, Figma, GitHub and other apps so the AI can use them, for yourself or for the team, and where to get the address or key each one needs.
---

The AI can use apps outside Trina AX for you: search your Notion pages, open a Linear issue, read a Jira ticket. You
connect each app once. For most apps there is nothing to copy: you sign in on the app's own page. A few apps, such as
GitHub, give you a key instead.

:::note
Before 0.4.0 this screen is called **External services**. These connections use MCP, a common way for apps to offer
tools to an AI; you don't need to know more about it to use them.
:::

## Which way your app connects

| App | What you need | Guide |
|---|---|---|
| Notion, Linear, Atlassian (Jira, Confluence), Figma, Canva, Stripe, Supabase, Cloudflare, Higgsfield, and the other apps in **Discover** | Your account at that app. Nothing to copy | [Sign in to an app in Discover](#sign-in-to-an-app-in-discover) |
| GitHub | A personal access token | [GitHub](#github) |
| Another app that publishes an "MCP server" address | The address, and a key if the app asks for one | [Add an app by its address](#add-an-app-by-its-address) |
| Your company's own system (an API) | An address, a key and notes | [Your company's API](api-connections.md) |
| Google Drive, Gmail, Calendar, Docs, Sheets | Your Google account | [Google apps](google-apps.md) |
| Slack | Nothing for members; an admin adds it once | [Slack](slack.md) |

## For you or for the team

| | For you | For the team |
|---|---|---|
| Where | **Settings › Connectors** | **Admin › Connected apps** (owners and admins) |
| Whose account the AI uses | Yours | The account that signed in, or the key that was saved |
| Who uses it | Only you, in your own chats | Everyone, groups or people the admin picks |
| Who sees it | Only you, not admins | Admins |

A team connection signs in **once, as one account**: everyone it is for acts as that account at the app. When each
person should act as themselves (their own Notion pages, their own GitHub rights), make a
[template](#templates-each-member-uses-their-own-key) instead, or let each person connect it for themselves.

## Sign in to an app in Discover

:::tip
**What you need**

- An account at the app (Notion, Linear …), signed in in your browser.
- Nothing to copy or paste: Trina AX fills in the app's official address.
:::

:::steps
#### Open Connectors
Choose your photo at the bottom of the bar on the left, then **Settings › Connectors** (on a phone, the **Me** tab).
**Discover** lists the apps you can connect. **Show all** lists every one; **Search apps** finds one by name.

![Connectors: nothing connected yet, with Discover under it on the same page](../images/mcp/connected.webp "Settings › Connectors")

#### Open the app and choose Connect
The app's page says what the AI can do there and lists its tools. Choose **Connect** (or the **+** in the list). A
member also sees **Ask admin to add it**, to ask for it for the whole team.

![Notion's page in Settings › Connectors: Connect, Want it for the whole team? Ask admin to add it, what the AI does, and its tools](../images/connect/notion-page.webp "Notion's page")

#### Save and sign in
The dialog shows the app's official address. Leave **Advanced** as it is and choose **Save and sign in**.

![The Add Notion dialog: the address filled in, Advanced folded, and Save and sign in](../images/mcp/add.webp "Add Notion")

#### Allow access on the app's page
A new window opens on the app's own page (Notion, Linear …). Sign in if it asks, pick the workspace, and choose
**Allow** (the button may be called **Continue** or **Accept**). The window closes and Trina AX says **Signed in.**
The app moves up to **Your connectors** with **Connected**.
:::

For the team, an admin does the same in **Admin › Connected apps**: open the app and choose **Connect for the team**.
The arrow beside it offers **As a template: each member connects**. Then choose who may use it.

![Notion's page in Admin › Connected apps: Connect for the team with an arrow for more choices, and Connect Notion for the team with one shared key, or as a template each member connects with their own.](../images/connect/admin-notion.webp "Notion for the team")

Sign-in has to happen on a computer, in a browser or the desktop app. Once connected, it works on your phone too.

## GitHub

GitHub doesn't let other apps sign in on their own, so you connect it with a personal access token. Only owners and
admins can add an app by its address; a member asks an admin, who can make a
[template](#templates-each-member-uses-their-own-key) so each person uses their own token.

:::tip
**What you need**

- **Address**: `https://api.githubcopilot.com/mcp/` (GitHub's MCP server).
- **Key**: a personal access token from GitHub, starting with `github_pat_`.
:::

:::steps
#### Make a token at GitHub
Open [GitHub › Settings › Developer settings › Personal access tokens › Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)
and choose **Generate new token**. Give it a name ("Trina AX"), an expiry date, the repositories it may open
(**Only select repositories** is safest) and the permissions the AI needs, such as **Contents**, **Issues** and
**Pull requests** set to **Read-only**, or **Read and write** if the AI may change them. Choose **Generate token** and
copy it: GitHub shows it only once. Details: [GitHub's guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

#### Add it in Trina AX
In **Admin › Connected apps**, choose **Add one by its address** (under Discover) or **Add**. Fill in:

- **Name**: `GitHub`
- **Address**: `https://api.githubcopilot.com/mcp/`
- Open **Advanced** and set **Sign-in method** to **API key**.
- **Header for the key**: keep **Authorization: Bearer (default)**.
- **Key**: paste the token.

![Add an app for the team, filled in for GitHub: the address https://api.githubcopilot.com/mcp/, Header for the key Authorization: Bearer (default), the Key, and under Advanced: For the team (one key), MCP server, API key, Ask every time](../images/connect/add-by-address-key.webp "GitHub with a token")

#### Save
Choose **Save**. Trina AX checks the token with GitHub and lists the tools it offers. The line shows **Connected**.
:::

## Add an app by its address

Any app that publishes an "MCP server" address can be added, even if it isn't in Discover. Owners and admins add it in
**Admin › Connected apps** › **Add one by its address**. A member sees "Not listed? Ask an admin to add it."

:::tip
**What you need**

- **Address**: from the app's help pages, usually a page called "MCP", "MCP server" or "Connect to AI tools". It
  starts with `https://` and often ends with `/mcp`.
- How the app signs in: on its own page (**Sign in (OAuth)**), with a key (**API key**), or not at all (**None**).
- For a key: the **Key**, from the app's settings ("API keys", "Tokens", "Developer"), and the **Header name** if the
  app's help names one, such as `X-API-Key`.
:::

The dialog's fields:

| Field | What to put there |
|---|---|
| **Name** | The name people see in chats, such as "GitHub". |
| **Address** | The app's MCP address. Starts with `https://`. |
| **Who connects** (Advanced) | **For the team (one key)**, or **Template: each member connects their own**. |
| **Type** (Advanced) | **MCP server**. Choose **API** only for a plain web API: see [Your company's API](api-connections.md). |
| **Sign-in method** (Advanced) | **Sign in (OAuth)**, **API key** or **None**, as the app's help says. |
| **Header for the key** | Keep **Authorization: Bearer (default)** unless the app's help names another header. Then choose **Another header** and type its **Header name** exactly. |
| **Key** | The key, pasted whole. You can't see it again after saving. |
| **Sign in with my own app** (Advanced) | Only for apps that ask you to make your own sign-in app, such as Google's MCP servers. See [Sign in with your own app](api-connections.md#sign-in-with-your-own-app). |
| **Writing, deleting and sending** (Advanced) | Whether the AI asks first (below). |

:::warning
Put the key in the **Key** field, never in the address (`…?key=…`). People who use a team connection can see its
address, and the AI reads it.
:::

## Changes need a yes

Reads run at once. Everything else is a write, and follows the connection's **Writing, deleting and sending** setting:

| Setting | What happens |
|---|---|
| **Ask every time** (default) | Trina AX shows a card with everything that will be sent. Nothing goes until a person says yes. |
| **Block writing** | Lookups only; writes are refused. |
| **Run without asking** | Writes run without asking. Only admins can choose this, and only for team connections. |

Whoever manages a connection can also turn single tools off on its page. What an app sends back is treated as outside
data, never as instructions. In a scheduled task nobody can say yes, so writes are refused, except to a **Run without
asking** team connection allowed on the task's card.

## Templates: each member uses their own key

Many apps give a key its owner's rights and log every call under that person's name. For those, an admin adds a
**template**: the app is registered once, and each member connects it with their own key or sign-in.

:::steps
#### Add a template
In **Admin › Connected apps**, choose **Add one by its address** (or, on an app's page, the arrow beside **Connect for the team** › **As a template: each member connects**). Under **Advanced**, set **Who connects** to **Template: each member connects their own**. Fill in the
address, the sign-in method and who it is for. There is no key field, and the address can't have a `?…` part: a key
there would reach every member. Use **Note for members (optional)** to tell people where to get their key.

![Add an app for the team as a template for GitHub: No key here: each member adds their own, Who connects set to Template, and a note for members saying where to make the token](../images/connect/template.webp "A template")

#### Members connect
The members it is for get a notice in **Activity**, and see it in **Settings › Connectors** under **Your connectors**,
with a **Team** label and **Connect**. They enter their own key or sign in. It becomes their own connection, used only
in their chats.
:::

| | Team connection (one key) | Template |
|---|---|---|
| Key | One, added by the admin | Each member's own |
| Whose rights the AI uses | The key owner's, for everyone | Each member's own |
| What the admin sees | The connection | Who connected it and when, and whose key stopped working; never a key |

On the template's line in Admin › Connected apps, **Template · N connected** opens who it is for: **Connected**,
**Not connected** or **Key stopped working**. A scheduled task that needs a template doesn't run without your own key:
its result says "Needs your own key for …" and links to **Connect**.

A member can change only their key or sign-in and the write setting, and can disconnect at any time. If the admin
changes a template's address or sign-in method, every member's key is deleted and they connect again; a new name or
note keeps everyone connected. Deleting the template, or removing someone from it, deletes their connections.

## Ask a member to connect

An admin can also send one member a request with the app filled in: **Admin › Connected apps** › the arrow beside
**Add** › **Ask a member to connect**. The member gets a notice and connects with their own key, or declines. The admin
never sees the key.

## Connect from a chat

You can also ask in a chat: "Connect Linear." The AI fills in the app's official address and shows a card. You only
sign in or paste the key into the card. The key never reaches the AI.

## Problems

| What you see | What to do |
|---|---|
| **Sign-in needed** | The sign-in ended or the key was revoked at the app. Open the connection and choose **Sign in again**, or **Replace key**. |
| **Signing in has not finished yet.** | The sign-in window was closed or is behind another window. Choose **Open sign-in window**, or cancel and try again. |
| **Access was not allowed at the service.** | You chose Cancel or Deny on the app's page. Sign in again and allow it. |
| **Could not check the connection.** with "401" or "unauthorized" in the reason | The key is wrong, expired, or was copied with a space. Copy it again with the app's copy button. For a header other than Bearer, check the **Header name** letter by letter. |
| **The service listed no tools.** | The address isn't an MCP address (often the app's home page was pasted). Use the address from the app's MCP help page. |
| A member can't find the app | Members connect apps from **Discover** only. Ask an admin to add it by its address, or as a template. |

## The other direction

Your own Claude (Claude Code, Claude Desktop or claude.ai) can connect **to** Trina AX and use your files with your
permissions. [Read about the Team AX MCP connector](../agents/mcp-connector.md).

Full details for developers: [Integrations](../../INTEGRATIONS.md).
