---
title: Key concepts
description: Teams, people, folders, chats, projects, skills, engines and MCP in one page.
---

Trina AX has a few building blocks. Every other page uses these words.

## People and roles

| Role | Can do |
|---|---|
| **Owner** | Everything an admin can, plus team-level choices such as updates, restores, removing members and the team name. |
| **Admin** | Manage members, groups, folder permissions, the team's AI connections and engines, and team settings. Admins cannot read other people's chats. |
| **Member** | Chat with the AI, use files and skills they may open, and keep personal folders and skills. |

A **group** is a set of people, such as Sales or Finance. Folder rules can name groups or people.

## The team folder

All company knowledge lives in one team folder on the server.

| Folder | Who sees it |
|---|---|
| `shared/` | As the folder rules say, usually the whole team. |
| `groups/<group>/` | People in that group, unless a rule adds others. |
| `projects/<project>/` | As the folder rules say. |
| `skills/` | Everyone reads. Skill managers change it. |
| `users/<id>/` | Only that person. Not even the owner or admins. |

A folder or file you cannot open is invisible: in Files, in AI answers, in search, previews, history and trash. [Read about files and permissions](../use/files-and-permissions.md).

## Chats and projects

A **chat** is a conversation with the AI. Only its owner sees it.

A **project** is a folder with instructions, for work that keeps coming back to the same files. A chat in a project gives the AI that folder and those instructions. [Read about chats and projects](../use/chats-and-projects.md).

## Skills

A **skill** is a `SKILL.md` file with a name, a description and a procedure. It tells the AI how your team does a task. It never grants extra access. [Read about team skills](../use/team-skills.md).

## Engines and AI connections

An **engine** is the agent that answers:

| Engine | Notes |
|---|---|
| Claude Code | The default engine. |
| Codex | OpenAI's agent. Not available on an office Mac. |
| API | Experimental. Uses a configured API address, model and key. |

An **AI connection** is the account an engine uses: a Claude subscription, an API key or a ChatGPT sign-in. Connections can be personal, or shared by a group or the whole team.

## MCP and other connections

An **MCP connection** lets the AI use an outside service, such as Notion or Linear, with a person's or the team's own sign-in. Trina AX also works the other way: your own Claude can connect to Trina AX as an MCP server. [Read about MCP](../use/mcp.md).

## Scheduled tasks and usage

A **scheduled task** repeats a request on a schedule, in the team's time zone. **Usage** counts answers, tokens and estimated cost per person, with optional limits. [Read about scheduled tasks](../use/scheduled-tasks.md).
