---
title: Admin
description: What owners and admins manage, and where each setting lives.
---

**Admin** in the sidebar is for the owner and admins. Every page in it is for the whole team, and says so next to its
title. It opens on **Home**, which lists what needs attention first.
For the owner, Home also lists the first setup steps that are still to do: check the AI connection, set folder
permissions, invite your team, prepare a team skill, make the first backup. A finished step leaves the list.

![Admin Home: Needs attention at the top, then one card per area, with the Admin menu on the left](../images/admin/home.webp "Admin Home")

## The Admin menu

| Group | Pages |
|---|---|
| **People** | Members & invites, Groups, Folder permissions |
| **AI** | AI providers |
| **Connections** | MCP, App connectors, AI apps, Plugins |
| **Activity** | Usage, Activity log |
| **Team** | Team settings, System |

:::note
Earlier versions had the AI accounts on their own **AI connections** page, next to **AI engines**. Both are one
**AI providers** page now, and the old addresses open it.
:::

## Your first week

:::steps
#### Set permissions
Assign folders to groups and check access with two test accounts. [Read about permissions](files-and-permissions.md).

#### Connect the AI
In **AI providers**, the owner chooses **Add account** in the Claude Code or Codex row and connects an authorized
Claude or OpenAI account. Each row shows whether that engine is ready.

![Admin › AI providers: Claude Code, Codex and the API engine, each with its state, models, check again and an on/off switch](../images/admin/engines.webp "AI providers")

#### Invite the team
Start with a small pilot group, then confirm roles and folder access.

#### Add a first skill
Copy a starter skill and review its result against the sources. [Read about skills](team-skills.md).

#### Make a first backup
Back up, then practise a restore with IT. [Read about backups](../operate/backups.md).
:::

## What admins cannot do

- Read other people's chats. The activity log shows which files the AI read, not the conversation.
- See personal folders or personal skills in `users/<id>/`.
- Use a team MCP connection, unless a rule names them.

:::warning
People who operate the server, its OS or its storage can read stored files and chats. In hosted plans, that includes Trina's operators.
:::

## AI providers

**Admin › AI providers** has two tabs.

| Tab | What it holds |
|---|---|
| **Providers** | One row per engine (Claude Code, Codex, API): its state, sign-in mode, models and last check, with **↻** to check again and an on/off switch. Under Claude Code and Codex, the accounts the team answers with, in the order they are tried, with **Add account** for the owner. |
| **Team provider settings** | The default engine and model, answers at the same time, who may pick the engine, switching to Codex at Claude's limit, usage limits, and whether members may add their own accounts. |

Click an engine's name to open its details: what is missing and how to fix it, every model, and for the owner the API engine form.

![An engine row opened: the reason it is not ready, its sign-in mode, models and last check](../images/admin/engines-open.webp "An engine opened")

![Admin › AI providers › Team provider settings: team defaults, who picks the engine, the switch to Codex, and usage limits](../images/admin/engines-team.webp "Team provider settings")

Save and Cancel appear in a section only after you change something in it.

:::note
The two tabs are new in 0.4.0. In 0.3.0 and earlier, everything is on one **AI engines** page.
:::

## Activity log

**Admin › Activity log** lists sign-ins, admin actions, file changes and AI tool use, grouped by day. The filters stay at the top while you scroll. It never shows chat content.

![Admin › Activity log: filters for kind, person and time, then one line per event, grouped by day](../images/admin/activity-log.webp "The activity log")

## System

**Admin › System** has backups, diagnostics and updates. Diagnostics shows problems such as a missing engine, a failed check or disabled automatic updates.
