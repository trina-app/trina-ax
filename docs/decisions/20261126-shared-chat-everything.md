# Shared chats: everything a private chat does, behind the one notice or the read card

- Date: 2026-11-26
- Status: accepted
- Supersedes: the shared-chat exclusions that were left after [20261126-shared-chat-own-tools.md](20261126-shared-chat-own-tools.md):
  `rooms/ai-tools.ts` SHARED_TOOLS "no chat title, no Google Drive, no room reading" and SHARED_UNDER_ALWAYS ("offered
  there only under Always": decisions 1 and 2 of [20261123-ask-registry-findings.md](20261123-ask-registry-findings.md)
  for project members, folder access, skill folders and deletes of team files), the Drive, rooms and connect lines of
  [20261118-shared-chat-connections.md](20261118-shared-chat-connections.md), "Slack reading stays off there", and
  `chat/prompt.ts`'s list of what is "not available in a shared chat" for a member
- Branch: feat/shared-chat-everything (the owner, 2026-11-26)

- **Ask:** the owner, 11-26: "다 되는거 아니야?" In a shared chat the asker's AI should do everything it does in a private
  chat. Where other people would see something they cannot open, the one-time notice or the read card asks the asker
  first. No blanket offs (AI should match Claude Code; Rule A, teammates are trusted).
- **Rule:** for a member's own request, a shared chat (a team project's chat or a chat shared with people) offers every
  tool their own chat offers, with their own access. Each one runs behind the guard it needs, never a refusal:
  - a change: its own card, which only the asker sees (`set_title` needs none: the title is the chat's, as a rename on
    the screen is; `move_skill`, `delete_files`, `change_project_members`, `change_folder_access`, `skill_files`,
    `connect_service`'s sign-in card). The person's Always skips it as anywhere.
  - something some people here cannot open: the shared chat's read card (TurnExec.confirmSharedRead with the places it
    found): rooms (`rooms`, `room_read`, `room_file`; a room some of them are not in, or a part of it they do not see),
    files and folders shared with the asker one by one (`shared_with_me`, and the read tools open them by their links or
    paths here too: TurnFiles.grantReads; the source is the owner's place, whose readers are the owner and the share's
    people), what the asker has open (`looking_at`), the asker's folders (`my_folders`, their names), and a computer
    upload attached before the chat was shared (now a reference to that file of the sender's own folder: behind the read
    card in a project chat, a copy kept with the chat in a chat shared with people, as any file of their own folder).
  - the asker's own Google Drive and Slack: the once-per-place notice a connection has ("Other people in this chat can
    also see what the AI gets from Google Drive.", Continue), kept in `card_always_allow` as `seen:drive:<place>` /
    `seen:slack:<place>` (no connection row, so no migration) and listed in Settings › Allowed for Trina, where it can be
    reset (`oseen:<service>:<place>`). What it returns joins the answer's read record as the asker's own (or, for a
    Drive the team shares, its people's). `save_connector_file` with `drive:` goes the same way.
- **Rule, other people's words:** another person's message never drives the asker's tools: each turn is its sender's,
  with their own access and their own connections, and every change keeps its card. After other people's words a
  folder access change still needs the folder and the person named in the asker's own message, and nothing goes into a
  skill folder from a chat others wrote in, as after a room read in a private chat.
- **Rule, a project's own room:** in a team project's chat a call that names the project's own chat room reads it with
  no card, as before (only what everyone who sees the chat sees there); any other room the asker is in goes through the
  read card.
- **Rule, situation and approvals:** the "About this person and place" block and the model-pick line are in shared
  chats too (the asker's own facts; the team's plan is left out while a guest sees the chat). The asker's "earlier yes"
  approvals of this chat (card-approvals) count there too: they are theirs, per chat and target, used only by their own
  turns, as their Always holds there (Rule A).
- **Kept:** the asker's memories from other chats stay out ([20261125-auto-memory-shared-chats.md](20261125-auto-memory-shared-chats.md));
  guest limits (a guest's own turn keeps its tools: no title, only their invited group chat as a room, only the AI's own files to the trash; team
  connections are off while a guest is present; guest wording); the personal-skill copy check; a scheduled run's
  skipping of places nobody can answer for; the dev environment's own-folder and login limit
  ([20261118-devenv-shared-chats.md](20261118-devenv-shared-chats.md)); a search without a path covers only what everyone
  here may read (a path asks); folder access only for a folder everyone here can open, and project members only of this
  chat's own project (their result names people and places for everyone here).
- **Why:** the read card and the notice already protect what one person may open from the others in the chat; a blanket
  off protected nothing more and only sent the asker to another chat.
