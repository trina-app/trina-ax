---
title: Files and permissions
description: The team folder, folder sharing, and how the server checks every file the AI opens as the person asking.
---

Company knowledge lives in one team folder on the server. Each folder's sharing decides who sees what. The AI never sees more than the person asking.

## The team folder

| Folder | Who sees it | Use it for |
|---|---|---|
| `shared/` | As its sharing says, usually everyone | Company-wide documents |
| `groups/<group>/` | That group, plus anyone it is shared with | Team documents, such as Sales or Finance; the group's own skills in `skills/` there |
| `projects/<project>/` | The project's members only | Work with its own folder and instructions |
| `skills/` | Everyone reads; skill managers write | Team skills and team rules |
| `users/<id>/` | Only that person | Personal files and personal skills |

## How access is decided

One permission function on the server decides every access. The OS stops the AI from going around it.

- A file you cannot open is **invisible**, not "denied". Files, AI answers, search, previews, version history, trash and live updates all follow the same rule.
- Access **adds up**, as in Google Drive: a person gets what a folder gives them and what every folder above it gives them. The widest access wins. Only **Limit access** on a folder stops what comes from above.
- A project's folder opens only for the project's members.
- Changes apply **at once**. The AI reads permissions again on every tool call.
- Removing access does not erase earlier answers that quoted a file.

### Chat attachments in group folders

A file sent in a department's channel goes into that group folder's **Chat attachments** folder (named in the team's
language), as a project room's files go into the project's. Everyone who can open the group folder can open it there,
and owners and admins can too, because they can always open team folders: they see the channel's new uploads in Files
even when they are not in the department, though not the conversation. When the group folder is shared wider than the
department, uploads stay in the channel instead, marked **Only in this conversation**. If a group folder is shared wider
later, the files already in its Chat attachments follow the folder's new sharing. [Read about department
channels](chats-and-projects.md#a-departments-room-and-its-folder).

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

Owners and admins can also ask Trina in a chat: "give the Sales group view access to Reports", "let Jun edit Sales/Q4", "take the Design group off Reports". One person or group and one folder at a time. A card asks first: it names who gets or loses access and how many people can open the folder before and after. When files inside are shared one by one with people who lose the folder, the card asks whether those shares go too. The card offers **Always allow** for this kind of change; once you choose it, Trina makes these changes without asking, and files shared one by one inside stay shared. General access and Limit access stay in this dialog. A member who asks gets **Ask an admin**, which sends the team's owner and admins a message from you; a folder you can't open is answered as if it didn't exist.

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
  person you add by name also gets a phone notification (**Settings › Notifications › Sharing** turns these off).
- **People with access** lists the owner and each person or group with **Can view**. **✕** removes someone's access (asked first).
  The file's owner can always remove people, also while member sharing is turned off for the team.
- Someone you removed sees "Mina stopped sharing this file" when they open the file's link, and can ask for access
  again. They get no notice about it.
- You can also ask Trina in a chat: "share the quote with Jun", or "stop sharing the quote with Jun". A card under the
  answer says what changed: the file and where it is, who can view it, and one button. After a share the button is
  **Manage access**, which opens this dialog. After a stop it is **Undo**, and the card says who can still open the
  file and why (for example through a group it is still shared with, or because they can open its folder). Trina asks
  first before it shares a file, unless your message named the file and the person. Stopping needs no question when
  your message named them. When someone can already open the file, the card says so and nothing changes for them.
- When Trina can't share a file, the card says why and has the next step as its one button: **Ask Mina** for a file
  Mina owns (she gets the request in **Activity** and decides), or **Ask an admin** when the team turned off member
  sharing (the team's owner and admins get a message from you asking to turn it back on).
- A team file also opens for everyone who can open its folder.
- **Copy link** gives the file's own link. People with access open it; anyone else sees **You need access** and can **Ask for access** with a note. The request comes to the owner in **Activity** with **Share** and **Decline**, and as a phone notification. The link page never shows the file's name to someone who can't open it.
- Moving a file somewhere fewer people can open says how many people have it by its link.
- Ask Trina **"who can open this file?"** or **"why can't Jun open it?"**. She tells you how each person gets in (shared
  by name, through a group, through its folder). You see the names for your own files; for someone else's file you see
  your own access and who to ask.
- After Trina posts to a room, she tells you when people there can't open a file of the post. **Let them view** shares
  your file with exactly the people named on that line. For someone else's file, **Ask** sends its owner a request in
  **Activity** ("Alice asked you to share Quote.pdf with Jun") with **Share** and **Decline**. For a team folder, a
  member gets **Ask an admin**, which sends the team's owner and admins a message from you.

Owners and admins can share any team file. In **Admin › Team settings**, **Members can share files and folders they own** turns sharing off for members (shares already made keep working, and their owner can still stop them). The team owner can **Remove all file shares** there at once.

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

You can also ask Trina: "share the folder Work with Jun". Trina shows a card first, with the folder, where it is and what it holds (choosing **Always allow** for sharing files does not cover folders). The card offers **Always allow** for folder shares; once you choose it, Trina shares your folders without asking. Asking it to stop sharing (or to take someone off) works right away when your message names the folder: its name in quotes, like `"Work"`, or where it is, and the card that says so has **Undo**.

### Files shared with you

**Files › Shared with me** lists the files people shared with you, newest first, with who shared it and when. A file
you can already open in its folder shows here only when someone added you by name. Open a file there to view or
download it; **‹ Shared with me** takes you back to the list. Opening a file also marks its notice in **Activity** as
read. A file leaves the list when you lose access to it (its owner removed you, moved it to the trash or can no longer
edit it).

Trina can use these files too. Ask "summarise the file Mina shared with me" and it looks through what was shared with
you, also when a file in your own folders has the same name. On a shared file's page, **Ask Trina** opens a new chat
with that file ready in the box. Trina can view a shared file, not change it.

### "This file", "that thread"

When you say "summarise this" or "reply in that thread" without a name, Trina checks what you have open in the app:
the file, room, thread or chat on your screen, the window you are writing in first. It only does this when you point at
something without naming it, and it asks when two things could be meant. Anything it shares or posts for you this way
shows you a card first, unless you chose **Always allow** for that kind of card. Nothing about your screen is kept: a closed window
is forgotten, and a confidential chat is never reported.

## Working with files

![The Files screen: the team folder with Company-wide, Groups, Projects, Team skills and Personal](../images/files/files.webp "The Files screen")

![Files on a phone: Recent files, Team folders, Project folders, My files and Trash](../images/files/files-phone.webp "Files on a phone")

- **Upload** files or whole folders from the Files screen.
- **Download**: in the desktop app a file you download goes straight into your computer's Downloads folder, and a notice offers **Show in folder**. A file with the same name is kept: the new one is saved as "name (1)". In a browser, the browser decides where downloads go.
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
