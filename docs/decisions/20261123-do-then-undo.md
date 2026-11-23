# Do it, then offer undo: what the person named goes without a card

- Date: 2026-11-23
- Status: accepted
- Supersedes: [20261116-no-card-after-explicit-ask.md](20261116-no-card-after-explicit-ask.md) in part (the skip now
  also holds where content others wrote was read, with the floor below instead); the registry's open decision 4
  for `schedule.create` ("keep as is", [ASKS.md](../ASKS.md) Findings)
- Branch: feat/fewer-asks-undo (the owner: "질문수도 줄어야해", "7번이나 묻는건 좀 그런거 아냐?"; the ask-reduction study of
  2026-11-23, top five ideas and the 16 small dialog changes)

- **Ask:** 34 asks in the owner's 14 flows were too many. Act on what the person clearly asked for and show undo, as
  Gmail (undo send), Google Drive (undo toast), ChatGPT Tasks and Cursor do. Keep asking only where undo cannot help.
- **Floor, narrowed 2026-11-23 (the owner: "8번 저건 진짜 개너무 한데?? 견적서 2번도 개많아"):** only content from someone
  else's private place (their DM, a private channel, a team file the person may not share) whose source the person did
  not name. The person's own folder, browser and connections, a chat they are in (the AI's work there is theirs) and a
  team file they may share themselves are not on it. Their own folder read in their own project chat asks nothing.
- **Floor (as first written):** sending to someone the person did not name or clearly refer
  to; showing people content they could not see from a source the person did not name (a 1:1 or group chat, a room, a
  connected service, the in-app browser, a file shared with the person, a team file nobody named, anything not known);
  real money; permanent delete with no trash; a schedule that sends to others with nobody watching. Rule A still holds:
  the person's Always skips the first two. Decided once on the server, `server/src/chat/explicit-send.ts floorFree`.
- **Rule: named sends.** `post_to_room`: the asker's own message asks to post and names the place (a room, a person, a
  title such as "팀장님" that resolves to one person, `@everyone` in their own words) and nothing is on the floor: it
  goes without the card, with copies of the person's own files (or files they named or the AI made in this answer) and
  no view grant (as under Always). Still asks: another person wrote in the chat, a room read (except content the person
  already sent on a card in this chat to everyone the new place holds: one card per source, `post_sources`, never wider), a guest 1:1 or a guest in the room when
  files go, a screen target, a waiting rerun, Slack and runs. `share_with_person`: the same in shared and project chats
  nobody else wrote in. `share_folder` add: the person's own folder (named, or the one they used last in this chat) with
  people they named, a resolved title, or "팀원들" (the project's or their group's people, never guests). When the
  files are only in the chat (the person's own attachments here) there is no folder to pick: on the same clear ask it
  makes a folder in their own files named for the chat, puts copies in it and shares that ("<폴더>를 만들고 공유했어요 ·
  취소"; 취소 stops the share and deletes the folder and the unchanged copies). A guest here or an unclear recipient:
  nothing is made, the AI asks for the folder as before. The app's
  "Send to a conversation" sends at once when the server marks the confirm `direct`. Undo: the posted card offers 취소
  for 10 s (the room's delete of the message: its text, files and notices), then 지우기; the share card offers 취소 for
  10 s (takes back the people it added: the server records the grants each share wrote, and 취소 removes only
  those, never access someone had before; POST /api/files/shares/take-back, the sharer's alone, once); the app's toast offers 취소. A phone notice already delivered stays on the
  phone (the message it opens is gone).
- **Rule: titles.** A title or role is looked up in the person's aliases, then the team owner for an owner word, then
  the directory's job titles (an owner's or admin's title names them alone; a member's own title is asked about, since
  members set their own), then, only for a word that means "the one above me" (상사, boss, manager), the project's
  creator or the one owner or admin. A rank nobody holds is nobody. A Korean title counts with an honorific or particle
  and never right after a name ("김팀장님"). Several: the AI asks once; the person's own answer (their pick on a card, or
  their next message naming one teammate in full, in a chat only they write in) is kept as their alias (Settings ›
  트리나에게 허용한 것, removable). "팀원들" counts only in its plural or "my team" forms.
- **Rule: typed addresses.** While the server does not know its exit address, a plain address the person typed (or
  allowed on a card, also their schedule's) opens without the card. Private addresses stay refused after the lookup.
- **Rule: schedules.** A task the person asked for in their own words (when it runs, or the word schedule) that sends
  nowhere (no connection, no pinned recipient, no save folder), with only addresses they typed and no random-looking
  part, in a turn they watch (also in a shared chat with no guest, whose runs post only there), after no room read, whose words do not say to send, post or
  share, is made without its card ("tomorrow" needs a time). Its runs send, post and share nothing whatever the
  person's Always says (`schedules.quiet`, migration 451). Its step shows the next run with Pause and Delete. Anything
  else keeps the card.
- **Rule: connector tiers.** Read: no card (as before). Create: a tool the service marks `destructiveHint: false`, whose
  name starts with a create verb with no other change, message, share or money word, no recipient in its schema or call,
  no team files, not `api_request`, not a Google app, no word for something others reach (public, webhook, key, token,
  user, member, repo, issue, release, deploy…): no card in a turn the person watches, not in a run, not after the chat
  read a room, a connected service, the browser or other people's content, not with a guest in a shared chat, and on a team connection only when its admin's rule sends without asking (an
  admin's "ask" asks for a create too). Change, delete, send and unknown: the card, with its Always.
- **Rule: project saves.** In a project chat, a save into that project's folder from the person's own files (their
  folder only: never the browser, a connection or a share) where everyone who can see it sees the chat and no guest
  does, in a chat nobody else wrote in and that read no room: no card. Versions and the trash keep it undoable.
- **Rule: project saves, own folder (2026-11-23, F10).** In the person's own project chat the own-folder skip of reads
  covers the save card too (the AI's working file in their folder), only while nobody else wrote in the chat. A chat
  shared with people keeps it (the floor).
- **Rule: "this folder" for a file the AI made (2026-11-23, F5).** The files the person's latest answer that made any
  carries in the chat's own place (chat:files), each wholly theirs, in a chat that holds only their own work, count as
  the chat's files: the same folder of copies as for attachments, on the same clear ask, with the same Undo.
- **Rule: dialogs.** 15 screen confirm dialogs became an Undo toast or a notice (ASKS.md lists the 11 removed and the
  partial ones). The Google account check after a Drive sign-in stays: it keeps a sign-in someone else started out of
  this person's Drive connection.
- **Left out:** one card per answer for every kind, team default allows, a first-run allow screen, auto mode, an admin
  "ask every time" switch for the create tier, holding phone notices for the undo window.
- **Version impact:** minor (new behaviour, no API removed; `Step.scheduled`, `AnswerShareConfirm.direct`, the alias
  allowance and migration 451 are additive).
