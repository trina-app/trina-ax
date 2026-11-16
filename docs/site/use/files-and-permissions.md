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

## Share a folder

Owners and admins share a folder like in Google Drive: **Files › a folder's ⋯ › Share**, or **Admin › Folder permissions › Share**. Both open the same dialog.

:::steps
#### Add people and groups
Type a name. Each person or group gets **Viewer** or **Editor**. **Remove access** is in the same menu.

#### Check General access
**Restricted**: only the people listed can open it. Or the whole team, as **Viewer** or **Editor**. A folder without a setting of its own shows what it gets from the folder above, with **Change there**.

#### Check before saving
The dialog names who will gain or lose access. Nothing changes until you save. Giving more access asks first, and so does a limit that shuts out people the folder above lets in.
:::

![Share "Marketing": Add people and groups, People with access with Sam Ortiz as Viewer, Dana Brooks as Editor from "budget" with Change there, and Owner and admins as Manager, then General access Restricted and Settings › Limit access](../images/files/share-dialog.webp "A folder's Share dialog")

Access adds up, as in Google Drive: what a folder gives comes on top of what the folders above give. A role lower than that cannot be picked; the row says where the higher one comes from ("Editor from "Company-wide"").

To give a folder less than the folders above, turn on **Settings › Limit access**. Then only the people and groups added there open it. **Access removed** lists the people who can open the folder above but not this one; **Add** brings one back as Viewer. Turning the limit off again raises any role lower than the folders above to that level.

The owner and admins can always open team folders, except projects they are not a member of. They show as one **Manager** row.

:::note
After the update that made access add up, some folders list their people by name (tagged **Added when folders changed**), and Folder permissions shows a one-time notice naming them. People added by name keep access if they later leave the group. **Admin › Groups** and the person's page say so before saving, with **Remove now**.
:::

**Admin › Folder permissions › Folders** lists only the folders shared differently from the folder they are in, in the same names as Files, with **Limited** on the ones that keep people out. **Share** opens the folder's Share dialog. Project folders are one line: their members are changed on the project.

![Admin › Folder permissions › Folders: the folders shared differently, each with who and Share](../images/files/folder-permissions.webp "Folder permissions, folders")

**What a person can open** shows, for one person (and so their AI), each folder with Viewer or Editor and why, and the folders they can't open.

:::warning
`skills/` holds instructions that every member's AI follows. Write access there makes someone a skill manager. Before the AI saves into `skills/`, the server asks a person to confirm. The same goes for a group's `groups/<group>/skills/`: every member of that group's AI follows it, and any member who may write the group's folder changes it.
:::

![What a person can open: each folder with Viewer or Editor and why, then what they can't open](../images/files/by-person.webp "What a person can open")

## Share a file

You can share a file you own with chosen people, without changing who can open its folder: **Files › a file's ⋯ › Share**. Add people or groups and press **Share**. They can view the file and download it; they don't see the rest of the folder. Each person you add sees it in **Activity**.

- **Everyone on the team** is the first choice in **Add people or groups**. Before you press **Share**, a line says
  that everyone on the team will be able to open the file, also people who join later. Guests never can. It counts as
  one of the 50 people and groups a file can be shared with.
- When you share several files at once (for example in the last step of **Find work files on this computer**), each
  person gets one notice in **Activity**, "Mina shared 5 files with you", which opens the list of those files. A
  person you add by name also gets a phone notification (**Settings › Notifications › File sharing** turns these off).
- **People with access** lists the owner and each person or group with **Can view**. **✕** removes someone's access (asked first).
- A team file also opens for everyone who can open its folder.
- **Copy link** gives the file's own link. People with access open it; anyone else sees **You need access** and can **Ask for access** with a note. The request comes to the owner in **Activity** with **Share** and **Decline**, and as a phone notification. The link page never shows the file's name to someone who can't open it.
- Moving a file somewhere fewer people can open says how many people have it by its link.

Owners and admins can share any team file. In **Admin › Team settings**, **Members can share files they own** turns sharing off for members (shares already made keep working). The team owner can **Remove all file shares** there at once.

### Share a folder in My files

You can share a folder in **My files** the same way, like a folder in Google Drive's My Drive: **Files › a folder's ⋯ ›
Share**. The people and groups you add can view everything in it, including files you add later, and cannot change
anything. They find it in **Files › Shared with me** and open it like a folder, one level at a time: names, sizes and
dates, and each file to view or download. They never see the folders above it.

- The dialog says what the folder holds ("3 files, 1 folder"). **Everyone on the team** has its own line: everyone,
  also people who join later, will see everything in the folder and whatever is added to it. Guests never can.
- In **Files**, a shared folder says **Shared**, and a file inside it says **Shared through Work** (in its own Share
  dialog the folder's people show "Through Work").
- **Stop sharing** takes everyone off at once. It first lists what stays shared on its own (files and folders inside
  that you shared separately). After it, **Undo** puts the people back for a few minutes. Taking people off and Stop
  sharing always work, also when your team turned sharing off for members.
- Your personal folder itself and the places Trina keeps there (downloads, images, skills, project folders and a few
  others) can't be shared; the dialog says why.
- If the folder on the server is no longer the one you shared (for example it was replaced outside Trina), sharing is
  **paused**: nobody can open it, and you get a notice. Open its Share dialog and press **Resume**.

In **Admin › Team settings**, the switch is **Members can share files and folders they own**, and **Remove all file
shares** counts files and folders apart.

### Files shared with you

**Files › Shared with me** lists the files people shared with you, newest first, with who shared it and when. A file
you can already open in its folder shows here only when someone added you by name. Open a file there to view or
download it; **‹ Shared with me** takes you back to the list. Opening a file also marks its notice in **Activity** as
read. A file leaves the list when you lose access to it (its owner removed you, moved it to the trash or can no longer
edit it).

## Working with files

![The Files screen: the team folder with Company-wide, Groups, Projects, Team skills and Personal](../images/files/files.webp "The Files screen")

![Files on a phone: Recent files, Team folders, Project folders, My files and Trash](../images/files/files-phone.webp "Files on a phone")

- **Upload** files or whole folders from the Files screen.
- **History**: every change keeps a version you can open or restore.
- **Trash**: **Files › Trash** lists what you could restore, by name and the place it was in ("price-sheet.xlsx · Company-wide › Sales"). A file deleted more than once is one row with its copies: **Restore** brings back the latest, and opening the row restores any other copy. If the list has other people's deletes, **Deleted by me** shows only yours. Items are removed for good after the team's retention period (Admin › Team settings, 30 days by default); each row says when.
- **Formats**: the AI reads text from PDF, Office and HWP/HWPX files, and sees photos and scanned pages as images (admins can turn that off). Linux servers run no OCR.
- **Confirmation**: when the AI would write restricted content somewhere more people can see, the server asks first.

## HTML to PDF

An HTML file, such as a quote or a report the AI wrote, becomes a PDF that looks like the page: its colours and backgrounds, merged table cells, page size and margins from the page's own `@page` rule (A4 when it names none) and its page breaks.

- **In the preview**: open the `.html` file and press **Save as PDF** in the preview header. The PDF is saved next to the page with the same name, and the notice links to it. A second PDF of the same page is saved as `name (2).pdf`, never over the first. In a folder you can only read, the PDF is downloaded instead. On a phone the action is in the **⋯** menu.
- **Ask the AI**: "Make quote.html into a PDF". The AI prints the page itself; it does not rewrite it as Markdown.
- **What the PDF uses**: the page and its own pictures, stylesheets and fonts in the team folder, by relative path. Web addresses are never loaded: a web picture shows as a grey box, as in the preview. Save the picture into the team folder and refer to it by path. Scripts in the page do not run, so a part a script would draw is missing; write that part as plain HTML.
- **Limits**: up to 200 pages and 50 MB, and about a minute per page. A few PDFs are made at a time on a server; the rest wait.
- **Where it works**: the server prints with a headless Chromium in its converter sandbox, with no network. A Linux server has one when Debian's `chromium` package is installed (the dev environment installs it, and so does a hosted server image made with the dev environment). On a Linux server each print runs with its own memory limit, apart from other conversions, and needs at least 3 GB of memory on the server (two prints at once from 6 GB). A server without a browser, or with less memory, does not show the action, and the AI says it cannot print HTML. An administrator can name the browser with `MYCEL_HTML_PDF_BROWSER` ([environment](../reference/environment.md)).

Full details: [Security and permissions](../../security-and-permissions.md) and the [permission model (Korean)](../../PERMISSIONS.md).
