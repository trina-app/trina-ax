---
title: Files and permissions
description: The team folder, folder rules, and how the server checks every file the AI opens as the person asking.
---

Company knowledge lives in one team folder on the server. Folder rules decide who sees what. The AI never sees more than the person asking.

## The team folder

| Folder | Who sees it | Use it for |
|---|---|---|
| `shared/` | As the rules say, usually everyone | Company-wide documents |
| `groups/<group>/` | That group, plus anyone a rule adds | Team documents, such as Sales or Finance; the group's own skills in `skills/` there |
| `projects/<project>/` | As the rules say | Work with its own folder and instructions |
| `skills/` | Everyone reads; skill managers write | Team skills and team rules |
| `users/<id>/` | Only that person | Personal files and personal skills |

## How access is decided

One permission function on the server decides every access. The OS stops the AI from going around it.

- A file you cannot open is **invisible**, not "denied". Files, AI answers, search, previews, version history, trash and live updates all follow the same rule.
- A person's access comes from the **nearest rule** above the file that names them. Person rules come before group rules. With several groups, the widest access wins.
- Changes apply **at once**. The AI reads permissions again on every tool call.
- Removing access does not erase earlier answers that quoted a file.

## Change folder rules

Admins use **Admin › Folder permissions**.

:::steps
#### Pick a folder
**By folder** shows the team folder as a tree. Each row says who can open it and where that comes from.

![Admin › Folder permissions › By folder: the team folder as a tree, each folder with who can open it](../images/files/folder-permissions.webp "Folder permissions, by folder")

#### Choose the basic access
Follow the folder above, only the people named, everyone reads, or everyone reads and writes.

#### Add people and groups
Give each read, read and write, or no access. So "everyone reads, but not Bob" is possible.

#### Check before saving
The server works out who loses or gains access, and the Save button says it. Nothing changes until you save.
:::

**By person** shows what one person, and so their AI, can see, and why.

:::warning
`skills/` holds instructions that every member's AI follows. Write access there makes someone a skill manager. Before the AI saves into `skills/`, the server asks a person to confirm. The same goes for a group's `groups/<group>/skills/`: every member of that group's AI follows it, and any member who may write the group's folder changes it.
:::

## Working with files

![The Files screen: the team folder with groups, projects, shared, skills and users](../images/files/files.webp "The Files screen")

- **Upload** files or whole folders from the Files screen.
- **History**: every change keeps a version you can open or restore.
- **Formats**: the AI reads text from PDF, Office and HWP/HWPX files, and sees photos and scanned pages as images (admins can turn that off). Linux servers run no OCR.
- **Confirmation**: when the AI would write restricted content somewhere more people can see, the server asks first.

Full details: [Security and permissions](../../security-and-permissions.md) and the [permission model (Korean)](../../PERMISSIONS.md).
