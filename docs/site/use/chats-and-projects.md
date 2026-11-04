---
title: Chats and projects
description: Ask the AI, follow its steps, and keep repeat work in a project folder with instructions.
---

A chat is a conversation with the AI. Only you see your chats. Admins see which files the AI read, never the conversation.

## Start a chat

:::steps
#### Open a new chat
Choose **New chat** in the sidebar, or type in the box on the home page.

#### Ask in plain words
For example: "Summarize last week's sales notes in shared/sales." Type `/` to pick a team skill.

#### Follow the work
Open **N steps** under an answer to see each tool the AI used and each file it read.
:::

## How an answer works

| Topic | What happens |
|---|---|
| **Engine** | Members get the team default. People an admin allows can pick an engine and model in the chat. |
| **Files** | The AI uses Trina's file tools. Each call is checked against your own permissions. |
| **Questions** | When the AI needs a choice or a confirmation, it shows a card. It cannot answer that card itself. |
| **Helpers** | For big requests the AI can split work into sub-tasks, up to 4 at a time. Each helper works as you. |
| **Length** | One answer may use tools up to 150 times by default (admins choose 10 to 500). At the limit, **Continue** picks it up. |
| **Web** | The AI can open web pages. The server checks each address, and asks you before risky ones. |

:::note
Selected context goes to the AI provider you connected. Self-hosting is not offline processing. [Read the data flows](../operate/security.md).
:::

## Projects

A project is a folder of the team folder, plus instructions. Use it for work that keeps coming back to the same files: a launch, a client, a quarter's report.

:::steps
#### Make a folder a project
In **Files**, open the menu of a folder you can write and choose **Make it a project**.

#### Write the instructions
Say what the work is and how the AI should help. The first paragraph shows under the project's title.

#### Chat in the project
Start a chat from the project's page, or move a chat in from the chat title's menu. The AI then gets that folder and those instructions.
:::

- There is no member list. Whoever can read the folder sees the project.
- A folder holds one project. Once it is a project, only an admin moves, renames or deletes the folder.
- Instructions you did not write all by yourself count as outside content. The AI asks before it remembers anything after reading them.

## Deleted chats

Deleting a chat moves it to **Deleted chats**, where you can bring it back for 7 days by default. Admins can choose 1 to 365 days.
