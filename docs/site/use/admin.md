---
title: Admin
description: What owners and admins manage, and where each setting lives.
---

**Admin** in the sidebar is for the owner and admins. It opens on **Home**, which lists what needs attention first.

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
The owner connects an authorized Claude or OpenAI account in **AI connections**.

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

## System

**Admin › System** has backups, diagnostics and updates. Diagnostics shows problems such as a missing engine, a failed check or disabled automatic updates.
