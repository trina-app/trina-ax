---
title: Scheduled tasks
description: Ask once and let the AI repeat the work on a schedule, in the team's time zone.
---

A scheduled task runs a request again and again: every weekday morning, every Monday, the first of the month. It runs as the person who made it.

:::note
From 0.4.0, scheduled tasks have their own **Scheduled** page: a row near the top of your Trina list (on a phone, in the **☰** menu of the **Trina** tab); **New scheduled task** in ⌘K opens it too. Before that, they are under **Settings › Schedules**.
:::

![The Scheduled tasks page beside the Trina list: a weekly summary task with what it does and when, and a New task button](../images/scheduled/list.webp "Scheduled tasks")

## Create a task

Choose **New task**. There are two ways:

![The New task menu with Describe it in a chat and From a template](../images/scheduled/new-task.webp "New task")

- **Describe it in a chat.** For example: "Every Monday at 9:00, summarize last week's notes in shared/sales." The AI creates the schedule and shows it.
- **Start from a template.** Pick a template, fill in its folders and time, and save.

## What a run can do

| Topic | In a scheduled run |
|---|---|
| **Permissions** | The owner's folder permissions and the owner's skills. |
| **Time** | The team's time zone. |
| **Questions** | Nobody is there to answer, so nothing that needs a person runs, except what the task's card allowed (below). |
| **Web** | At most 8 new web addresses per run that do not need a person. |
| **Large downloads** | A file over 1 GB is skipped instead of asked about. |

## Saving and sending without asking

A run has nobody to answer a confirmation, so the task's card asks once, when the task is made, edited or checked again:

- **Save folder.** "Saves new files in: shared/Weekly reports (30 people can see it now). Content that may go there: My folder, #Sales conversation". Runs put **new** files there and in its sub-folders without asking, at most 20 a run. They never change or replace a file there that they did not make, and never touch skills or instruction files. If a run read something fewer people may see that the card does not list (another folder, another room), it saves in your own folder instead and says why.
- **Your own connections.** "Where it may send: My Notion · 'Daily notes'". Runs send only to the recipients on the card.

If the save folder is moved, renamed or deleted, its permissions change, or you can no longer write there, the task shows **Check the save folder again** with **Check again**, and you get one notice. Until you check it, runs save in your own folder. People joining or leaving a group do not change anything.

In **Edit**, the **Save folder** field picks another folder or removes it (×), and each item of the content that may go there can be removed (×).

## Manage a task

Open a task to see its schedule, instructions, next run and last run.

![A task page: the title with Run now and an On switch, Runs on the left, and Instruction, Repeats, Runs with and Details on the right](../images/scheduled/task.webp "A scheduled task")

- **Run now** runs it at once.
- The switch pauses and resumes it.
- The menu on its name has **Edit** and **Delete**.

A finished one-time task, or one that can no longer run, says why it cannot be turned on.

## On a phone

The tasks are one list, with a search box above it and **+** at the top for a new task.

![Scheduled tasks on a phone: a search box and the tasks in one column, with the tabs Trina, Chats, Projects, Files and Me at the bottom](../images/scheduled/list-phone.webp "Scheduled tasks on a phone")
