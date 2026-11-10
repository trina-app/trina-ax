---
title: How AI works inside Trina AX
description: The engines, the tools an answer can use, the permission check on every call, and the limits that apply.
---

Inside a team, the AI is a real agent: Claude Code, Codex or the API engine. It runs on the team server, as the person who asked.

## Engines

| Engine | id | Notes |
|---|---|---|
| Claude Code | `claude-code` | The default. Can use an Anthropic-compatible gateway on self-hosted servers. |
| Codex | `codex` | OpenAI's agent. Not on office Macs. |
| API | `api` | Experimental. A configured address, model and key. |

The engine's own shell and file tools are turned off. Its only path to the team's files is Trina's tools.

## Tools an answer can use

| Kind | Tools |
|---|---|
| Files | `list`, `glob`, `grep`, `read`, `write`, `edit`, plus `move_files`, `copy_files`, `rename_file`, `share_file`, and `delete_files` (to the team trash after the person's yes on a card; own chat only) |
| Search and web | `knowledge_explore`, `web_fetch`, `save_url` |
| Documents | `make_file`, `edit_hwp`, `hwp_render`, `artifact` |
| Skills and memory | `skill`, `find_skills`, `remember` |
| People | `ask_user` (a card the person answers) |
| Schedules | `schedule_create`, `schedule_list`, `schedule_delete` |
| Connections | The tools of MCP connections, and `api_request` for HTTP connections |

The exact set depends on the engine, the team's settings and the person's connections.

## The rules on every call

- **Permissions.** Each file call is checked as the person asking. A file they cannot open does not exist for the AI.
- **Outside content.** File contents, web pages and service answers are data, never instructions.
- **Confirmation.** Writing restricted content where more people can see it asks the person. So does saving into `skills/`. The AI cannot answer these cards itself.
- **Web addresses.** The server checks each one. Addresses the AI wrote itself ask the first time for each site.
- **Records.** Every tool call is recorded. Admins see which files were read, never the chat.

## Sub-agents

The AI can split a big request into sub-tasks, up to 4 at a time. A helper works as the same person, with the same checks and records, but cannot ask the person, remember, schedule or use the browser. Admins can turn this off.

## Limits

| Limit | Default |
|---|---|
| Tool rounds per answer | 150 (admins choose 10–500) |
| Answer time | 20 minutes |
| Usage | Token limits per person, group or team, if set |

In a scheduled run nobody can answer cards, so anything that needs a person is skipped or refused.
