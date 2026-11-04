---
title: Glossary
description: Short definitions of the words used in Trina AX and these docs.
---

| Term | Meaning |
|---|---|
| **Activity log** | Admin records of actions and tool calls. Shows which files the AI read, never the chat. |
| **AI connection** | The account an engine uses: a Claude subscription, an API key or a ChatGPT sign-in. |
| **App connector** | The Team AX MCP connector: your own Claude connecting to a team. |
| **Confidential chat** | A chat that never uses the web or sends sound out (with Safe operations 1A on). |
| **Core** | Team AX, the shared codebase Trina AX is built on. |
| **Engine** | The agent that answers: Claude Code, Codex or the API engine. |
| **Group** | A set of people that folder rules can name. |
| **Local-login** | Engines use the server OS user's own CLI sign-in. Used by office Macs and development. |
| **Managed** | Engines use AI connections through the model proxy. Used by Linux servers. |
| **MCP** | Model Context Protocol. How the AI talks to tools and outside services. |
| **Model proxy** | The server part that adds real keys to model calls, and counts usage. |
| **Owner** | The one person with every admin power plus team-level choices. |
| **Plugin** | A package admins install: a skill bundle or an isolated native tool. |
| **Project** | A team folder with instructions. Chats in it get that folder and those instructions. |
| **Relay** | The service that gives a team server a public address through outbound connections. |
| **Scheduled task** | A request the AI repeats on a schedule, as the person who made it. |
| **Skill** | A `SKILL.md` file: a reusable procedure. Never extra access. |
| **Skill manager** | A person who can change team skills, through write access to `skills/`. |
| **Sub-agent** | A helper the AI starts for part of a big request, working as the same person. |
| **Team folder** | The folder tree on the server: `shared/`, `groups/`, `projects/`, `skills/`, `users/`. |
| **Turn** | One answer from the AI, with all its tool calls. |
