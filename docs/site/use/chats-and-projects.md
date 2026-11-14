---
title: Chats and projects
description: Ask the AI, follow its steps, and keep repeat work in a project folder with instructions.
---

A chat is a conversation with the AI. A new chat is yours alone until you [share it](#share-a-chat); a chat in a team
project is shared with the project's members unless you pick **Only me**. Admins see which files the AI read, never the
conversation.

## Start a chat

:::steps
#### Open a new chat
Choose **Ask Trina** at the top of your Trina list (**Trina** on the bar on the left), press ⇧⌘O (Ctrl+Shift+O on Windows), or type in the box on the home page. On a phone, the **Trina** tab opens on Home: type in the box at the bottom. The first time, under the box, **Ready in your
team** lists what your team set up: its skills (**Example** shows a result, **Try it** opens the skill) until you have run
one, and the team files (**Ask** puts a question about them in the box, not sent). With nothing set up yet, **Start
here** offers one question to send.

![Home: a welcome card with first steps, then "How can I help you?" and the message box, with + inside it on the left and send on the right](../images/chats/home.webp "Home, with the message box")

#### Ask in plain words
For example: "Summarize last week's sales notes in shared/sales." Type `/` to pick a team skill.

The message box has your text on top and one row of buttons under it, inside the box: **+** on the left adds files
(from your computer or the team's files), and on the right are the AI choice (for people an admin allows), the
microphone where they are on, and send (**↑**). Enter sends.

#### Follow the work
Open **N steps** under an answer to see each tool the AI used and each file it read.
:::

![An answer with its steps open: each search and the file the AI read, then the answer with a link to the file it used; this chat is shared, so the line under the box says 2 people can see it](../images/chats/steps.webp "An answer and its steps")

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

## Your Trina list

On a computer, **Trina** on the bar on the left opens your list of Trina chats beside the page. At the top are
**Ask Trina**, **Search**, **Scheduled** and **Team skills**. Under them, from the top:

| Part | What is in it |
|---|---|
| **Waiting for you** | Shows only while a chat waits for your answer, and opens it |
| **Pinned** | The chats you pinned |
| **Trina history** | All your other chats, newest first. A chat in a project shows the project's name at the end of its row |

A small mark says who sees a chat: a lock before the title for a chat only you see in a team project, and the
people icon for a shared chat. A shared chat others wrote in shows their faces at the end of its row instead (up to 3, 2 on
a phone); hover them to see their names. This is the same in your history, on a project's page and in search.

**Trina** on the bar also opens the waiting chat while it shows **?**. Chats you deleted are in **Deleted history**, in
the **⋯** menu next to **Trina history**. The filter button at the top of the list can show only some chats, for example the
ones that are answering or wait for you. Your projects have their own place: **Projects** on the bar.

On a phone, the **Trina** tab opens on Home. **☰** at the top opens your history: **Search**, **Scheduled**, **Team
skills**, then **Trina history** (your pinned chats first, then newest first, by date), and **Set your status** and
**Deleted history** at the bottom.

![The Trina list: Ask Trina, Search, Scheduled and Team skills, then Pinned chats and your Trina history, where two shared chats show the face of the other person who wrote in them](../images/chats/trina-list.webp "Your Trina list")

![On a phone, ☰ on the Trina tab opens Search, Scheduled, Team skills, your Trina history, and Set your status and Deleted history at the bottom](../images/chats/trina-drawer-phone.webp "The Trina history on a phone")

### Folders

Trina chats have no folders. To keep chats about one piece of work together, put them in a [project](#projects).

The **Chats** list has **Conversation folders** for rooms and direct messages. A folder sorts your list, nothing more:
it holds no files and never changes who sees a conversation. Make one with **New folder**, then use a conversation's
**···** › **Move to folder**. A folder's **···** renames it, moves it up or down, or deletes it; deleting a folder keeps
its conversations in your list.

## Several chats at once

Each chat in your list of Trina chats shows at most one mark, at the right end of its row:

| Mark | What it means |
|---|---|
| **?** in amber | The AI waits for you: a question or confirmation card, or an answer that failed or paused at a limit. A card's **?** stays until you answer it. |
| Grey ring | The AI is answering, or the answer waits its turn. |
| Dot, title in bold | A new answer you have not opened yet. |

Opening a chat clears its dot, and the **?** of a failed or paused answer, on every device. A folded section keeps the strongest mark of the chats in it. A room shows **?** in place of its count while the AI waits for your answer there.

While the browser tab is in the background, its title counts the chats and rooms that want you, for example "(2) Trina". The desktop app shows the same number on the Dock on a Mac, and a notification when a card opens or an answer that ran over a minute ends while you look elsewhere; clicking it opens that chat. Scheduled tasks get the mark only; a question asked from Slack is answered there, so its chat gets no dot. **Trina** on the bar on the left (on a phone, the **Trina** tab) shows **?** or a dot when a chat wants you, **Chats** shows **?** while the AI waits for your answer in a room, and on a phone a short message with **Open** appears in the app.

## Share a chat

You can share any chat of yours with people and groups, like a file in Google Drive. They see the whole chat, including what was said before they
were added, and can ask the AI in it themselves.

:::steps
#### Open Share…
In the chat's title menu, or in **···** on its row in your list, choose **Share…**.

#### Add people and groups
Type a name in **Add people and groups**. You are in the list as **Started this chat**. **✕** takes someone out again
(**Undo** puts them back until you save).

#### Save
Press **Share** (**Save** when it was shared already). Leaving with changes you did not save asks first.
:::

![The Share dialog of a chat: Add people and groups, then People with access with Jordan Lee (Started this chat) and Priya Nair with ✕, a note that everyone here sees the whole chat, and Save](../images/chats/share-dialog.webp "Share a chat")

- **Before new people are added**, the app checks what they would start seeing. If the chat used places some of them
  can't open, it says so, for example "1 person can't open some of what this chat used: groups/Marketing/". When it
  names answers ("2 answers here used places Priya can't open"), **Show answers** lists them. **Share anyway** shares
  the chat; **Cancel** leaves it as it was.
- **Files.** Files you attached from your computer before sharing become visible to the people you add, and the dialog
  says how many. In a shared chat anyone in it can attach a file from the computer (at most 50 MB a file): it is kept
  with the chat, and only the people who see the chat can open it and ask Trina about it. Deleting the chat deletes them.
- **Who sees answers.** Answers in a shared chat are never hidden from the people in it, including people added later.
  Each answer runs as the person who asked, with what they may open. Before the AI reads something some of them can't
  open, it asks you first.
- **What the others see.** The chat appears in their Trina list, and **Activity** says "Jordan shared a chat with you".
  When you add someone by name they also get a notification on their phone and in their browser (**Settings ›
  Notifications › Chats shared with me** turns it off). They can continue the chat with their own access, or choose
  **Hide from my list** in its menu; opening it again brings it back.
- **Change who sees it.** Only the person who started the chat changes who sees it: **Share…** again, or **Change who
  sees it** under the box. Someone you take out loses the chat and its files at once and reads "This chat is no longer
  shared with you". Taking everyone out makes it yours alone again.
- **Personal things stay out.** In a shared chat the AI does not use your memories, your browser, your email or your
  schedules. To use them, choose **Continue in a chat only you see** in the chat's menu.
- A chat in a personal project stays yours: **Share…** offers to move it out first. A chat in a team project is shared
  with the project's members (see [Projects](#projects)).

![The Share dialog after Share: Priya Nair marked New, a warning that 1 person can't open some of what this chat used (groups/Marketing/), and the Share anyway button](../images/chats/share-warning.webp "Before new people are added")

![Activity: Jordan Lee shared a chat with you, with the chat's title under it](../images/chats/shared-activity.webp "What the other person sees in Activity")

## Pin a chat

In your list of Trina chats, a chat's **···** (or a right-click on its row, or a long press on a phone) has **Pin to top**.
Pinned chats come first in your Trina list, the most recently pinned first, with a small pin before the
title, on a computer and on a phone. A project's page lists your
pinned chats there first too. **Unpin** puts a chat back. A pin is yours only, also on a shared project chat,
and it goes when the chat is deleted or you can no longer see it. You can pin up to 50 chats.

Conversations in **Chats** (rooms, DMs and group chats) are pinned the same way, from a row's **···** or the room's own
**···**: pinned ones come first, with a small pin after the name, in every list of conversations, on a computer and in the phone's **Chats** tab.
Only you see your pins. A pin goes when you leave the room or hide it. You can pin up to 50 conversations.

The **Chats** list shows every conversation: your pins, your folders, then **Team rooms** (the everyone room first, then
by name), **Group conversations** and **Direct messages** (the latest first). Conversations you hid are behind **Hidden conversations (N)**.

A direct chat with someone who left the team says "<name> left the team" and has no message box. The history stays readable.

## Team chat

**Chats** on the bar on the left (on a phone, the **Chats** tab) is where people talk to each other: **Team rooms**
(everyone in the team, and one room per group), **Group conversations** and **Direct messages**. **Mentions & threads**
at the top collects the messages that name you and the threads you follow.

To bring in someone from outside the team, choose **Invite a guest** when you add people to a group chat or a project. [Read about guests](guests.md).

![The Chats list: Mentions & threads, Team rooms with Everyone and Marketing, and a direct message](../images/chats/rooms-list.webp "The Chats list")

#### Ask Trina beside a room

The **✦** button at the top of a room opens a side chat with Trina next to it. Only you see this chat, and the AI
answers with what you may open. When an answer is worth sharing, **Send to room** under it puts it in the room as your
message (**Send to thread** when you asked about one message). If some people in the room cannot open a file the answer
used, the app tells you first and waits for your yes.

![The Marketing room: a message that names Jordan, a thread with 2 replies, and Trina's answer sent from the side chat](../images/chats/room.webp "A team room")

#### Reply in a thread

**Reply in thread** on a message keeps a side conversation under it, so the room stays easy to read. The room shows how
many replies a thread has; **Also send to the room** puts a reply in the room too.

![A thread open beside the room: the first message and its replies, with a box to reply](../images/chats/thread.webp "A thread")

#### Link to a message

**Copy link** in a message's **⋯** menu (on a phone, press and hold the message) copies its address. Paste it in any
room, group conversation, direct message or thread: it shows as the conversation's name, and the message shows under it
as a card with who wrote it, when, its words and its files. Click the card to open the message.

Each person sees the card only if they can see that message. For everyone else the link stays a plain link, and opening
it says the conversation can't be found. When some people in the conversation can't see the message, the box says so
before you send: **Only show link** (the default) sends just the link; **Show message** shows them a copy of the message,
marked as shared by you. A copy goes away if the original is deleted. To take a card off your own message, point at it
and click **✕** (or choose **Remove preview** in the message's menu).

![Chats on a phone: Mentions & threads, team rooms, a group conversation and a direct message, with the five tabs at the bottom](../images/chats/rooms-phone.webp "Chats on a phone")

### Guests

Someone from outside the team, such as an agency or a client, can join **one** group conversation or **one** project as
a guest. In a group conversation open its members (the name at the top), **Invite people**, then **Invite a guest**; in
a project, **Add people** in **Members**. Say who the link is for and whether they get AI, then **Create link**. The link
works once: send it to them yourself.

![Invite a guest: they'll see only the 'Launch email' room, a box for who it is for, and AI for them: No AI or Their own sign-in](../images/chats/invite-guest.webp "Invite a guest")

- A guest sees only that place: no Files, no other rooms or projects, no team areas.
- Their AI is off unless you choose **Their own sign-in**, or an admin gives them a **Team AI** account with a monthly limit.
- A **Guest** tag shows next to their name, and the header says **Includes 1 guest**.
- Admins see every guest in **Admin › Members & invites › Guests** ([Admin](admin.md#guests)).

![The Launch email group conversation: 4 members · Includes 1 guest, and Morgan Reyes with a Guest tag replying](../images/chats/guest-room.webp "A guest in a group conversation")

## Projects

A project keeps the chats, files and instructions of one piece of work together, for you or for the people you add. Use it for work that keeps coming back to the same files: a launch, a client, a quarter's report.

![Projects: New project, then the team projects you are in, each with its members and the work it holds](../images/chats/projects-panel.webp "Projects")

:::steps
#### Make a project
Open **Projects** on the bar on the left (on a phone, the **Projects** tab) and choose **New project**. Give it a name.
A new project is **Only me**: only you see it until you add people.

#### Write the instructions
Say what the work is and how the AI should help. The first paragraph shows under the project's title.

#### Chat in the project
Start a chat from the project's page, or move a chat in with **Move to project** in the chat title's menu. The AI then gets the project's files and instructions.

![A project page: the members' faces, the message box with + and the 3 people chip, Bring in chats, a line about 1 chat only you see with Choose chats to share, the Trina history with a chat Sam Ortiz also wrote in, and Instructions, Files and Members on the side](../images/chats/project.webp "A project's page")
:::

- Your projects are under **Projects**, on the bar on the left and on the phone's **Projects** tab: **Team projects**
  (others see them too) and **My projects** (only you). A project's name opens its page. A chat you open from a project
  goes back to that project; its chats are in **Trina history** in your Trina list too. The team folder and its trash are
  under **Files**.
- A project has members. On the project's page, **Members** shows who they are, and **Add people** shares a project
  that is only yours. Before it saves, it tells you that they can see and edit its files and instructions, that your
  chats so far stay yours, and that it cannot go back to only you. In some teams only the owner and admins share
  projects.
- A project can also have one or more guests: people from outside the team who see only this project. Its members can see the chats a guest has there. [Read about guests](guests.md).
- Only a project's members see what is in it. The owner and admins can change its members, but they do not see its
  chats, files and instructions unless they are members.
- A folder holds one project. Once it is a project, only an admin moves, renames or deletes the folder.
- **Move to trash** in a team project's menu puts it in the trash with its files. Its members keep its card, marked
  **In trash**: its page says who moved it there and when, and that an admin or its creator can restore it. Nobody
  opens its files, chats or instructions until then. An admin or its creator restores it on its page or in
  **Files › Trash**, where it is one row with the project's name. **Delete for good** is for admins only.
- Instructions you did not write all by yourself count as outside content. The AI asks before it remembers anything after reading them.
- **Chats in a team project are shared with its members.** A small chip after **+** in the project's message box says
  who will see the chat you're starting (for example **👥 3 people**). Press it to keep that chat to yourself (**🔒 Only
  me**); the next new chat starts shared again. A chat only you see shows a lock. Every question shows the picture and
  name of the person who sent it. Each answer runs as the person who asked, with their access. When the AI is about to
  read something some of them cannot open, it asks you first (**Read and share** / **Don't read**).
- **Chats you bring in or move in stay yours.** The project page says how many ("1 chat only you see"), and **Choose
  chats to share** (or **Share with project members** in a chat's menu) shares them. **Bring in chats** moves other
  chats in.
- **Files in project chats.** A file you attach from your computer (**+**, a paste or a drop) in a shared project chat
  is saved in the project folder's **Chat attachments** subfolder (named in the team's language), where the project's
  people can open it, and a line under it says so. You need write access to the project folder (without it, **+**
  offers team files only); **✕** before sending moves the file to the trash.

## Find anything

Press ⌘K (Ctrl+K on Windows) or choose **Search** under **Ask Trina** to find chats, messages in your conversations, projects, files, skills, scheduled tasks and MCP connections. [Read about search and settings](settings-and-search.md).

## Deleted chats

Deleting a chat moves it to **Deleted history**, where you can bring it back for 7 days by default. Admins can choose 1 to 365 days.

- A shared chat goes to the **Deleted history** of the person who made it. When a project's creator or an admin deletes someone else's shared chat, it is in their **Deleted history** too, for as long as they can still bring it back.
- Deleting a project for good moves its shared chats to the **Deleted history** of the people who made them. Brought back, such a chat is its maker's alone, without a project.
