# Leave a chat shared with you, and learn who took a chat away and why

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: fix/shared-chat-ux-gaps (scenario QA 11-22: TC-7650/7651, 7652/7653, 7272, 7289, 7341/7344, 7298/7431, 7265,
  7284, 7291, 7296/7433, 7400; plan docs/AGENTS/plan/20261122-0027-shared-chat-ux-gaps.md)

- **Ask:** in today's scenario QA people could not leave a chat shared with them (only "Hide from my list", which keeps
  everything open), lost chats silently when the creator stopped sharing, deleted the chat or left the team, saw no line
  for who added whom, and read "Stopped" with no reason when a removed teammate's answer stopped.
- **Leave this chat.** Someone a chat outside projects was shared with **by name** can leave it (title menu, row "⋯", the
  read-only who-sees dialog), after "Leave "{title}"? You won't see this chat or its files any more. {creator} can add you
  again." (`POST /api/chats/:id/leave`). Their name entry goes, their running and queued turns there stop (also while
  someone else's answer runs), their hide row and waiting file asks go, they are remembered as a past member, and it is
  audited (`chat.leave`, counts only). The last one out makes it its creator's own chat again. Its creator can't leave
  (400 `chat_leave_creator`: they delete). Someone who would still see it through a listed group is refused (409
  `chat_leave_group`, naming the group and the creator): a group entry is the creator's to change. Why it differs from
  "Leave a project" (which refuses anyone in through a group): a project's people are its folder's rules, a chat's are
  its own list; leaving takes out only what the person put themselves in by name. The 11-14 decisions offered recipients
  "Hide from my list" and recorded no reason against leaving; projects had Leave already.
- **Who changed its people.** Each save that adds or removes entries, and each leave, writes a `chat_audience_events` row
  (ids only). The chat page shows them between its messages as rooms do: "{actor} added {names}", "{actor} removed
  {names}", "{actor} left" (GET …/audience `events`, newest 50). Names are read when shown; people whose account is off
  are named only for its creator and admins (the audience list's rule); group sizes never. Someone added later sees the
  earlier lines too, as in rooms.
- **Lost-access notices ('chat.lost', `chat_lost_notices`).** Shown always, never pushed, at most one per person, chat,
  reason and day: "{name} stopped sharing a chat with you." (taken out by a save), "{name} moved a chat shared with you to
  the trash." (a restore takes the unread ones back) and "{name} is no longer on the team, so a chat they shared with you
  will be deleted on {date}." (its creator's account deleted; the date = the deletion plus the chat trash days, the
  sweeper's rule). No title is stored: the chat's title shows only while the reader sees it again (the 11-14 rule).
- **Delete confirm.** The creator's delete of a chat shared with people adds "{names} will lose access too." (up to three
  names, then "and N others").
- **Account removal.** The delete-account dialog counts every chat the person shared that someone else sees, not only the
  ones holding others' messages. The line under such a chat's box says "{name} is no longer on the team. This chat will be
  deleted on {date}." or "Shared with you by {name}. Their account is off now." (`Chat.shared.byGone`; everyone listed
  still sees it). An answer stopped because its requester's account was deleted or switched off says "{name} was removed
  from the team, so this answer stopped." / "{name}'s account was turned off, so this answer stopped."
  (`messages.stopped_for`; `stop_reason` keeps only the two limits). Only that person's own running answer is stopped;
  their queued turns are dropped and never stop someone else's running answer.
- **Smaller words.** Recipients open the read-only who-sees list from the header and the line under the box; a guest found
  in the Share search shows greyed with "Guests can't be added to shared chats."; a member who may not change a project's
  people reads "Only the person who created the project and admins can change who is in it."; the 50 MB refusal in a
  shared chat says to put a larger file in a team folder (up to 20 GB) and ask Trina there; the shared-chat prompt says
  Google Drive is off there whoever has it connected (never "connect it").
- **Not done:** a notice for every message of a shared chat (nobody, first or later member, gets one today; the only
  follow is per thread; a new feature for the owner); raising the 50 MB chat upload cap; a greyed Rename for
  non-creators (phase-4 "One item": no item for what a person can't do).
- **Crash (TC-7344):** the open tab of a switched-off account died because the service worker called `clearAppBadge()`
  on sign-out, which a Chromium without a worker handler for it answers by killing the process. The window clears the
  badge now; the worker never does.
- Version impact: **minor** (a new action and notice; migration 435 is additive).
