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
- **Floor (never removed without the person's Always):** sending to someone the person did not name or clearly refer
  to; showing people content they could not see from a source the person did not name (a 1:1 or group chat, a room, a
  connected service, the in-app browser, a file shared with the person, a team file nobody named, anything not known);
  real money; permanent delete with no trash; a schedule that sends to others with nobody watching. Rule A still holds:
  the person's Always skips the first two. Decided once on the server, `server/src/chat/explicit-send.ts floorFree`.
- **Rule: named sends.** `post_to_room`: the asker's own message asks to post and names the place (a room, a person, a
  title such as "팀장님" that resolves to one person, `@everyone` in their own words) and nothing is on the floor: it
  goes without the card, with copies of the person's own files (or files they named or the AI made in this answer) and
  no view grant (as under Always). Still asks: another person wrote in the chat, a room read (except content the person
  already sent on a card in this chat: one card per source, `post_sources`), a guest 1:1 or a guest in the room when
  files go, a screen target, a waiting rerun, Slack and runs. `share_with_person`: the same in shared and project chats
  nobody else wrote in. `share_folder` add: the person's own folder (named, or the one they used last in this chat) with
  people they named, a resolved title, or "팀원들" (the project's or their group's people, never guests). The app's
  "Send to a conversation" sends at once when the server marks the confirm `direct`. Undo: the posted card offers 취소
  for 10 s (the room's delete of the message: its text, files and notices), then 지우기; the share card offers 취소 for
  10 s (takes back the people it added); the app's toast offers 취소. A phone notice already delivered stays on the
  phone (the message it opens is gone).
- **Rule: titles.** A title or role is looked up in the person's aliases, then the directory's job titles, the owner for
  an owner word, the project's creator or the one admin for a lead word. One match names that person. Several: the AI
  asks once, and the answer is kept as the person's alias (Settings › 트리나에게 허용한 것, removable).
- **Rule: typed addresses.** While the server does not know its exit address, a plain address the person typed (or
  allowed on a card, also their schedule's) opens without the card. Private addresses stay refused after the lookup.
- **Rule: schedules.** A task the person asked for in their own words (when it runs, or the word schedule) that sends
  nowhere (no connection, no pinned recipient, no save folder), with only addresses they typed and no random-looking
  part, in a turn they watch, after no room read and with no guest in the chat, is made without its card; its step
  shows when it runs next with Pause and Delete. Anything else keeps the card.
- **Rule: connector tiers.** Read: no card (as before). Create: a tool the service marks `destructiveHint: false`, whose
  name starts with a create verb with no other change, message, share or money word, no recipient in its schema or call,
  no team files, not `api_request`, not a Google app: no card in a turn the person watches, not after a room read or
  in a run. Change, delete, send and unknown: the card, with its Always.
- **Rule: project saves.** In a project chat, a save into that project's folder from the person's own files (their
  folder or the in-app browser, never a personal connection or a share) where everyone who can see it sees the chat
  and no guest does: no card. Versions and the trash keep it undoable.
- **Rule: dialogs.** 15 screen confirm dialogs became an Undo toast or a notice (ASKS.md lists the 11 removed and the
  partial ones). The Google account check after a Drive sign-in stays: it keeps a sign-in someone else started out of
  this person's Drive connection.
- **Left out:** one card per answer for every kind, team default allows, a first-run allow screen, auto mode, an admin
  "ask every time" switch for the create tier, holding phone notices for the undo window.
- **Version impact:** minor (new behaviour, no API removed; `Step.scheduled`, `AnswerShareConfirm.direct`, the alias
  allowance and migration 445 are additive).
