# Fewer asks: do it, then offer undo (top 5 ideas and 16 confirm dialogs)

- Date (UTC): 2026-11-23 00:13
- Branch: `feat/fewer-asks-undo` (stacked on `docs/ask-registry`, #421)
- Status: in progress
- Where: server/src/chat, server/src/tools, server/src/integrations/connections, web/src. Why: the owner wants fewer
  asks ("질문수도 줄어야해"); the five top ideas of the ask-reduction study (2026-11-23) and its 16 small dialog changes.
- Version impact: minor: the AI does more without a card (posts, shares, schedules, connector creates, project saves)
  and the app shows undo instead of confirm dialogs.

## Goal

The 14 owner flows asked 34 times on 0.14.0; already-planned work brings that to about 26. These five changes bring it
to about 7. Each change replaces a card with "done, here is undo" (Gmail's undo send, Drive's undo toast, ChatGPT's
Tasks). What a card protected and undo cannot fix stays on the floor (below) and still asks.

## Floor (never removed)

1. Sending to people the person did not name (the AI chose, or the name is vague).
2. Showing content to others that they could not see, whose source the person did not name: a 1:1 or group chat, a
   room, a connected service, a file shared with me by someone else, or anything not known. My own files, my project's
   folder and a team folder are not this (the copy is mine to share).
3. Real money. 4. Permanent delete with no trash. 5. A schedule that sends to others while nobody watches.
The person's Always still skips 1 and 2 (Rule A).

## Scope

In:
1. **Named recipient and content: no card, then undo.** `post_to_room`: the explicit-ask skip also holds with files
   that go as copies, an artifact, people who cannot open a linked file, a chat others write in, a project chat, and
   `@everyone` when the person's own words have the room and the @everyone word. It still needs the post word and the
   place in the asker's own message, no screen target, no guest 1:1, not a waiting call's rerun, and no floor-2 source
   in the provenance. The post goes as Always's would (copies, no extra view grant: the "Let them view" button after the
   post stays). `share_with_person`: the skip also holds in a chat others write in or that read rooms (files and people
   still named in the person's own words). `share_folder` (add): a new explicit skip with the folder and every person
   or group named in the person's words. Web "Send to a conversation" (`ShareToRoom`, `SendHere`): the first press's
   preview sends at once when the confirm has no floor-2 source and was not asked again. Undo: the posted card shows
   "보냈어요 · 취소" for 10 seconds (deletes the room message, its notices and files), then a "지우기" button; the web
   send toast has the same 취소. The share card of a share shows "취소" for 10 s (takes the access back), then Manage.
2. **Typed addresses.** `gateUrl`: while the exit address is unknown, a plain address the person typed in this chat
   opens without a card in a turn they watch. Marked, long-query, echo and user-info addresses keep the card; private
   addresses stay refused after the lookup. The schedule card says runs can open the addresses the person typed.
3. **Schedules from the person's words.** `schedule_create` creates without the card when the asker's own message of
   this turn (not auto-sent, not Slack, not a run) asks for a schedule, the task sends nowhere (no connections, no
   pinned sends, no save folder), every address in the prompt was typed by the person, the prompt has no marked part,
   and no room or other person's content was read in the turn. The result step shows "예약을 만들었어요 · 다음 실행 …"
   with 멈추기 and 지우기 (a new `Step.scheduled`). Anything else keeps the card. Changes decision 4 of the registry
   ("keep as is").
4. **Three tiers for connector tools.** A new `create` tier: a tool the service marks `destructiveHint: false` (and not
   read-only) whose name starts with a create verb (create, new, add, make, generate, build) and holds no other change
   word, no communication or money word (message, comment, post, mail, invite, payment, order…), whose schema takes no
   recipient and whose arguments reach nobody, with no team files and not `api_request`: runs without the card in a turn
   the person watches, also in a shared chat. Read stays as is. Everything else (change, delete, send, unknown) asks as
   today, with its Always.
5. **Project saves.** `confirmWidening`: in a project chat, saving into that project's folder needs no card when every
   narrower source is the person's own files (their folder, browser or personal connection) or inside the project
   folder, and everyone who can see the target is a member of the project.
6. **16 confirm dialogs.** The doc's group A (9, they already have undo) loses the dialog and keeps the Undo toast;
   group B (7, only a notice) becomes a one-line notice or toast. Group A: ui.files.delete, ui.files.bulkDelete,
   ui.share.fileRemove, ui.share.fileStop, ui.chat.restoreVersion, ui.files.move.narrow, ui.files.bulkMove.narrow,
   ui.admin.folderSharing.removeRow, ui.auth.signOut. Group B: ui.files.move.skillsOn, ui.project.skillsOn,
   ui.projects.share.skillsOn, ui.guest.inviteSkills, ui.project.addMe, ui.admin.originKept, ui.drive.confirmAccount.

Out: one card per answer (idea 5), team default allows (6), the first-run screen (7), remembering titles (10), auto mode
(11), dialog groups C and D (drafts, a chat trash), an admin "ask every time" switch for the create tier, delaying push
notices for the undo window.

## Steps

1. Plan (this file), plan review by a fresh subagent.
2. Server: post/share/folder explicit skip with the floor check (`chat/explicit-send.ts` for the floor rule).
3. Server: url-gate typed, schedule no-card + `Step.scheduled`, connector create tier, project save.
4. Web: PostedCard undo/delete, ShareCard undo, ScheduledCard, ShareToRoom/SendHere direct send, the 16 dialogs.
5. docs/ASKS.md rows (and Summary), docs/PERMISSIONS.md / CONNECTIONS.md lines, decision file, changes/ note.
6. Tests per idea (explicit sends with no card, undo works, floor still asks), gate on the Mac mini, QA copy replay of
   F5, F7, F1/F4, F10 with ask counts before and after, security review by a fresh subagent, PR.

## Decisions

`docs/decisions/20261123-do-then-undo.md`: named recipient and content send with undo; the floor; typed addresses;
schedules from the person's words (replaces registry decision 4); the create tier; project saves. Changes
20261116-no-card-after-explicit-ask.md (the skip now also where others' words are, with the floor instead).

## Risks

- Injection: another person's message could steer the AI's text. The recipient must be in the asker's own message
  (server text match, as today), private sources keep the card, and undo is there. A pushed phone notice cannot be
  pulled back by undo (said in the PR).
- Create tier depends on the service's own `destructiveHint: false`; a tool without it asks.
- Overlap with #419, #420, #421 (base), #422 and the one-Always / connector-wide Always / A/B fixes / registry
  violation branches: post-to-room.ts, share-with-person.ts, tools.ts, ASKS.md. Kept to small, separate hunks.
- No migration. Five app languages for every new string.

## Tests

- post_to_room: explicit ask with a file copy / project chat / shared chat / @everyone sends with no card; a DM or room
  source, a vague recipient, a guest 1:1 still ask; undo deletes the message.
- share_with_person in a chat others wrote in, share_folder explicit: no card; unnamed person asks.
- url-gate: typed plain address with no exit address opens; marked address asks; schedule card wording.
- schedule_create: own words, no send: no card and a `scheduled` step; with a connection / a typed-by-AI address /
  after a room read: card.
- connector: create_app with destructiveHint false: no card; delete_app, create_message, no hint: card.
- project save: own files into the project folder: no card; a teammate's DM source: card.
- web: the 16 dialogs (no dialog, undo toast or notice), PostedCard 취소 / 지우기, ShareToRoom direct send.

## Result

(filled in at the end)
