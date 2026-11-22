# Shared chats: leave, lost-access notices, who-added lines and clearer words (scenario QA 11-22)

- Date (UTC): 2026-11-22 00:27
- Branch: `fix/shared-chat-ux-gaps`
- Status: done
- Where: Team AX core (`server/src/chat/{people-share,chat-audience,chat-lost}.ts`, `server/src/routes/chats.ts`,
  `server/src/admin/users.ts`, `server/src/notifications/*`, `server/src/chat/{runtime,turn,store}.ts` (stop reason only),
  `web/src/components/chat/*`, `web/src/pages/{Chat,Activity}.tsx`, `web/src/pages/admin/Members.tsx`, `web/src/i18n/*`).
  Why: shared chats, notices and the account screens are core (docs/REPOSITORY-RULES.md).
- Version impact: **minor** (a new action "Leave this chat", a new Inbox notice, new lines in a shared chat; one
  additive migration).

## Goal

Today's scenario QA (sheet tab QA) found gaps in chats shared with people (docs/DECISIONS.md "Chats shared with people
and groups" and its Share dialog section; memory sharing-model). People can't leave a chat, don't learn when they lose
one or why, and some refusals don't say what to do next. Each fix below is small. Together they make losing access and
being refused readable.

## Scope

In (each with its QA row):

1. **Leave this chat** (S-010, TC-7650/7651). Someone a chat was shared with BY NAME can leave it: the title menu, the
   row's "⋯" and the read-only who-sees dialog. A confirm in plain words: "Leave "{title}"? You won't see this chat or
   its files any more. {creator} can add you again." Leaving takes their name entry out (`chat_audience`), stops their
   running and queued turns there, drops their hide row and waiting file asks, remembers them as a past member, and is
   audited (`chat.leave`, counts only). Nothing of the chat is kept for them. The creator can't leave (they delete).
   Someone in the chat only through a listed group gets 409 `chat_leave_group` with words that say so ("You're in this
   chat through {group}. Ask {creator} to take the group out, or hide the chat from your list."), whenever they would
   still see it after their name entry goes (also when named AND in a listed group), because a group entry is the
   creator's to change. Leave runs the same stop → same-state check → transaction order as a save of the audience; a
   leaver's queued turn is dropped even while someone else's answer runs there. If the last entry goes, the chat becomes its creator's own again (as a save that removes
   everyone). The decision check: the 11-14 decisions offer "Hide from my list" for recipients and say nothing against
   leaving; projects already have "Leave". So leaving is a gap, not a rejected option (decision file below).
2. **Delete a shared chat: who loses it and a notice** (S-014, TC-7652/7653). The creator's delete confirm on a chat
   shared with people adds "{names} will lose access too." (names from GET audience, at most 3 then "and N more"). After
   the delete, the others get an Inbox notice "{name} moved a chat shared with you to the trash." A restore takes the
   unread ones back (Undo is one tap away); the notice opens the chat only while the reader sees it.
3. **Stopped sharing: say who** (S-003, TC-7272). People taken out by a save of the audience get a notice
   "{name} stopped sharing a chat with you." (one notice per chat and person per day). Lost notices store no title:
   the 11-14 rule (a chat's title only while the reader still sees it) holds; the title shows while they see it again.
4. **"{actor} added {names}" lines** (S-008, TC-7289). A save that adds people or groups, a leave and a removal write a
   `chat_audience_events` row; GET /api/chats/:id/audience returns the latest ones (at most 50) and the chat page shows
   them between the messages by time, in the rooms' event style: "{actor} added {names}", "{actor} removed {names}",
   "{actor} left". Names as each viewer may see them already (people and group names, no group sizes: S8 unchanged).
5. **Account removal** (S-035, TC-7341/7344; S-117, TC-7298/7431).
   - The delete-account dialog counts every chat the person shared with others (not only the ones holding others'
     messages): "{n} chats this person shared with others will be deleted too, and the people in them lose them.
     Disable the account instead to keep them." The count's endpoint stays.
   - Deleting the account sends the people in those chats the notice "{name} is no longer on the team, so a chat they
     shared with you will be deleted on {date}." (the date = deletion + the chat trash days, the sweeper's rule; the
     title while they still see it). Their windows get the chat again (chat.updated) so the line under the box changes.
   - The line under the box of such a chat names the change instead of the stale "{name} shared this chat with you":
     "{name} is no longer on the team. This chat will be deleted on {date}." (deleted creator) or "{name} shared this
     chat with you. Their account is off now." (disabled) (`Chat.shared.byGone`). Never "only you see it": everyone
     listed still sees it.
   - An answer stopped because its requester's account was deleted or switched off says why under it: "{name} was
     removed from the team, so this answer stopped." / "{name}'s account was turned off, so this answer stopped."
     (a new column `messages.stopped_for`: messages.stop_reason has a CHECK of the two limit reasons and tables are
     never rebuilt; read as `Message.stoppedFor`; `stopReasonOf`, `lastOutcome` unchanged). Only the removed person's
     own answer is stopped and labelled: `stopUserTurns` gets the runner-owner guard `stopUserTurnsIn` has (today a
     queued turn of theirs stops someone else's running answer), and their queued turns are dropped directly. The guest
     path (disableGuestIfPlaceless) gets the same.
   - The deactivated person's open tab crashed (TC-7344): find the loop and fix it so the tab shows the signed-out page.
6. **Notifications for later members** (S-039, TC-7406). Checked first: nobody in a chat shared with people (creator,
   first members or later ones) gets a notice for someone else's later message; the only standing follow is per thread
   under an answer (chat/threads.ts), which treats later members exactly like first ones. So there is no subscription
   that misses later members. A notice for every message is a new product feature (noise, a preference, push), left
   for the owner; reported on the row, nothing built.
7. **Upload limit words** (S-115, TC-7296/7433). The 50 MB refusal in a chat shared with people says where to put a
   larger file: "Files in a chat shared with people can be at most 50 MB. Put a larger file in a team folder instead
   (up to 20 GB), then ask Trina about it here." CHAT_FILE_MAX stays 50 MB (a product call).
8. **Connectors in shared chats** (S-045/S-046, TC-7400). The one prompt sentence about what a shared chat doesn't
   offer says Google Drive is not used in shared chats whoever has it connected (not a missing connection: never ask
   anyone to connect it), and to ask again in a chat only they see. "Continue in a chat only you see" exists in the
   chat's title menu (ChatTitleMenu `chat-continue-privately`), so naming it stays true. One parenthesis added to the
   existing sentence, nothing else (another agent owns the prompt rules).
9. **The people icon for recipients** (TC-7265). The header's "N people" and the line under the box open the Share
   dialog's existing read-only form for everyone in a chat shared with people (not only its creator). The read-only
   form keeps its "Only {name} can change who sees this chat." line and gets "Leave this chat" (item 1). Tooltip
   "See who can see it".
10. **Guests in the Share search** (TC-7284). A guest who matches the search shows greyed out with "Guests can't be
    added to shared chats." (the picker's existing `unavailable` row), instead of "No matches".
11. **Guest removal by a non-creator** (S-110, TC-7291). Changing a project's people by someone who may not answers
    "Only the person who created the project and admins can change who is in it." (new key), not the rename/instructions
    sentence.

Added by the coordinator (S-015..S-034):

12. **Rename for non-creators** (S-030, TC-7244). Renaming a shared chat is its creator's by design (plan
    20261114-shared-chats-everywhere "Rename, engine": creator). The UI has no dead control: the item is not shown to
    others (phase-4 "One item": no item for what a person can't do; the owner prefers a lean UI). QA met the 403 by
    calling the API. Nothing built; reported on the row.
13. **File Share dialog for a non-owner** (S-015, TC-7230) and **the owner's request card** (TC-7231): say who to ask by
    name (and reuse the existing ask-for-access flow if it fits without a new permission model); the card says what is
    shared and with whom ("Share only this file with {name}…"). Built in a side clone, merged here.
14. **Room video** (S-025, TC-7239): a thumbnail in the timeline and a player that is not squeezed in landscape.
15. **Restoring an old file version** (S-032, TC-7246): the confirm names the people whose later versions drop out of
    the latest; the others are told the same way an edit tells them (only if edits notify today; no new system).
TC-7236 is TC-7050 in the sharing lane: not here.

Out: whole-chat notices for every message (item 6); raising the 50 MB chat upload cap; the Share dialog's warning and
people-share copy (another agent owns them: this PR only adds the read-only "Leave" button and the guest row there).

## Steps

1. Migration `435_b_chat_leave_notices.sql` (component B's next free number; additive, reader 1): `chat_audience_events`
   (chat_id → chats ON DELETE CASCADE, at, actor_id, kind CHECK added/removed/left, subjects JSON),
   `chat_lost_notices` (Inbox rows of 'chat.lost': user_id, chat_id, by_user, reason CHECK stopped/deleted/account, day,
   read/suppressed; unique per user, chat, reason and day; no title) and `messages.stopped_for`. Account removal:
   `chat_lost_notices.user_id` in chat/account-cleanup.ts; `chat_audience_events.actor_id` and
   `chat_lost_notices.by_user` in KEPT_WITH_ACCOUNT (names a past action; the tombstone keeps the name). The notice
   sweep covers the new table (NOTICE_TABLES). Event lines leave out people whose account is off for viewers who are
   not the creator or an admin (the audience view's filter).
2. Server: `leaveChat` in people-share.ts + `POST /api/chats/:id/leave`; events written in putChatAudience and leave;
   `events` on ChatAudience; lost notices from putChatAudience (lost people), deleteChat (people-shared, others) and
   removeAccount (the person's people-shared chats); `chat.lost` in NotificationEventType, tableOf, NOTICE_TABLES,
   eventEnabled (shown always, no push), the Inbox output `chatLost {name, title, reason}` and a link while seen.
3. Server: `peopleSharedChatsOf` counts every people-shared chat of the person with someone else in it;
   `Chat.shared.byGone`; stop reason for removed requesters (runtime stopUserTurns(userId, why) → TurnExec stopWhy →
   messages.stop_reason; queued ones too); `Message.stoppedFor {reason, name}`.
4. Server words: chatFileTooLarge (6 languages), projectPeopleCreatorOnly, chatLeave* refusals; the prompt sentence.
5. Web: leave in chatActions + menus + read-only dialog; delete confirm names; who-sees opens read-only for everyone;
   guest rows; events lines in Chat.tsx; stoppedFor line in AssistantMessage; byGone footer; Activity/Notifications text
   for chat.lost; Members dialog wording; the crash fix.
6. en.ts first, then ko, id, ja, es, zh.
7. Tests (below), docs: `bun run docs:api`, a decision file, `changes/shared-chat-ux-gaps.md`, security matrix case for
   the new route, the web mock route.

## Decisions

- New: `docs/decisions/20261122-shared-chat-leave-and-lost-notices.md` (leaving a chat shared with people; the
  lost-access notice; who-added lines; account removal words).
- Builds on docs/DECISIONS.md "Chats shared with people and groups" (phase 3) and "…: the Share dialog" (phase 4).

## Risks

- Migration number: component B's highest on dev is 434 (`434_b_project_room_listed`; 600_f, 701_g, 702_g are other
  components); no open PR adds a B one. Recheck before the PR.
- Permissions: leave is the caller's own entry only (chatFor 'view', kind people, not creator); the events and notices
  name only people and groups the reader could already see in the dialog; no group sizes. New route in the security
  matrix.
- Notices name a chat title snapshotted when access ended (the person saw it then); never text of the chat.
- Six app languages; phone 390 and desktop 1440 for the menus, dialog, lines and Inbox row.
- turn.ts touched only for the stored stop reason (one field); api-honest.ts untouched.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `check:prepush`, `MIGRATIONS_BASE=origin/dev bun run check:migrations`;
server units under Bun 1.3.12: b-shared-chat-audience (leave, events, lost notices, group refusal), account removal
(count, notices, byGone, stop reason), notifications (chat.lost output), project participants wording, attachments
(new words); web units: chat menus (leave), delete confirm names, who-sees for recipients, picker guest row, events
lines, stoppedFor line, Activity text, the crash fix; full unit + security once; visual check on a private QA copy at
1440 and 390.

## Result

Built as planned with the plan review's points (see "Plan review"). Items 6 (whole-chat notices) and 12 (greyed
Rename) were not built, by decision. The crash (TC-7344) was the service worker's `clearAppBadge()` on sign-out; the
window clears the badge now. Side fixes merged in from their own plans: TC-7246 (restore confirm names), TC-7239 (room
video frame, player width when sideways), TC-7230/7231 (Share dialog asks the owner; request card says what Share does).
Code review applied: an invalid queued turn drops itself and never stops another's running answer; Leave only for
people listed by name (`Chat.shared.named`); message rows keyed by Fragment; ask-for takes a send token; a lost notice
reads the earlier share notice of that chat. Visual check on a private QA copy (port 19884) at 1440 and 390: A–C, E–G
pass; the guest row (D) needs a guest in a shared project to show and is covered by the unit test.

## Plan review (independent, applied)

Migration numbering per component; `stop_reason` CHECK → new column; runner-owner guard and queued drop; no "only you
see it"; deletion date; leave refused whenever they'd still see it; delete notice says trash and is taken back on
restore; no stored titles; account-removal coverage lists; push/preference exhaustiveness and route coverage; rename
item dropped (decision); prompt edit minimal. Kept in one PR because the coordinator asked for ONE PR.
