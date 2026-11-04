---
title: Admin
description: What owners and admins manage, and where each setting lives.
---

**Admin** in the sidebar is for the owner and admins. It opens on **Home**, which lists what needs attention first.

![Admin Home: Needs attention at the top, then one card per area, with the Admin menu on the left](../images/admin/home.webp "Admin Home")

## The Admin menu

| Group | Pages |
|---|---|
| **People** | Members & invites, Groups, Folder permissions |
| **Shared with the team** | AI engines, AI connections, MCP, Plugins |
| **Activity** | Usage, Activity log |
| **Settings** | Team settings, System |

## Your first week

:::steps
#### Set permissions
Assign folders to groups and check access with two test accounts. [Read about permissions](files-and-permissions.md).

#### Connect the AI
The owner connects an authorized Claude or OpenAI account in **AI connections**. **AI engines** shows whether each engine is ready.

![Admin › AI engines: Claude Code, Codex and the API engine, each with its state, models and an on/off switch](../images/admin/engines.webp "AI engines")

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

## Activity log

**Admin › Activity log** lists sign-ins, admin actions, file changes and AI tool use, grouped by day. The filters stay at the top while you scroll. It never shows chat content.

![Admin › Activity log: filters for kind, person and time, then one line per event, grouped by day](../images/admin/activity-log.webp "The activity log")

## System

**Admin › System** has backups, diagnostics and updates. Diagnostics shows problems such as a missing engine, a failed check or disabled automatic updates.
