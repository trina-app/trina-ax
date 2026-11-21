# Named group chats are private channels; Create a channel and New message are two ways in

- Date: 2026-11-17
- Status: accepted
- Supersedes: part of [Team rooms are Channels, and group chats are listed in Direct messages](20261116-sidebar-channels-dms.md) (named group chats are no longer in Direct messages)
- Branch: fix/named-groups-are-private-channels (the owner, QA TC-4461, TC-4462)

넣을 곳: Team AX core (`web/src/components/nav/RoomsList.tsx`, `web/src/components/rooms/*`, `web/src/lib/rooms.ts`,
`server/src/rooms/service.ts`, the six `web/src/i18n/*.ts`, `docs/site`), 이유: the Chats list, its words and making a
group room are core.

- **Ask:** follow Slack. A group room with a name of its own is a **private channel**; one without a name is a **group
  DM**. Making each has its own entry, so people never have to know that "a name decides".
- **Rule: where a group room is listed.** Channels: Everyone, the # team channels, and every group room (kind `group`)
  that has a name, with a lock (🔒) in place of the faces. Direct messages: 1:1s and group rooms with no name (null or
  only spaces), titled by their people with the face stack, by latest activity. Private channels sort with the other
  channels by name, Everyone first. A room moves at once when its name changes (the existing room.updated event).
- **Rule: two ways in, one dialog.** The Channels header has a "+" **Create a channel**: the people picker with a
  required name, asked first with its label and the focus (one other person is enough); the result is a private channel. The Direct messages header has a "+"
  **New message**: the same picker with no name field and "Start conversation" as its button; one person opens or makes the 1:1, two or more make a group DM,
  and the server opens the group DM of exactly those people if I am in one already (a named room never counts). The
  panel's top "+", the phone's top bar, ⌘K's "Message" and `/rooms?new=1` keep opening the picker, now as **New
  message** (the key `rooms.newChat` is renamed in words only), so there are two flows, not three. A guest gets neither
  "+", as before. Both header buttons are the shared `SectionAddButton` (also the folders' New folder).
- **Rule: names.** A group DM's "⋯" offers **Turn into a private channel** in place of Rename: it asks for a name and the
  room moves to Channels with the same people. A private channel's Rename needs a name (an empty name cannot be saved),
  so a channel stays a channel. The room info's name field follows the same rule. Team channels keep their old rename
  (empty goes back to the group's name).
- **Words:** a named group room says "private channel" (en private channel, ko 비공개 채널, ja プライベートチャンネル,
  zh 私密频道, es canal privado, id saluran privat): add people, leave, the guest's removal note, the rename field, and
  the notification level "Direct messages and private channels". An unnamed group room keeps its people's names and
  "group chat" where it is a group DM. Code names (kind `group`), the API and the DB stay.
- **Server:** POST /api/rooms with `kind: 'group'` takes one other person when a name is given (was two); with no name
  it still needs two, and returns the existing group DM of exactly the same people. Old clients keep working: what they
  sent before is still accepted. Existing rooms are not changed.
- **Unchanged:** unread counts and Mentions only (roomCounts), notification defaults (a named group keeps its level),
  the Files button, pins, folders, the sections' fold state, the room kinds.
- **Tests:** `web/test/unit/rail-panels-p3.test.ts`, `web/test/unit/room-pins.test.tsx` (placement and the move on
  rename), `web/test/unit/room-picker.test.tsx` (the two flows), `web/test/unit/room-hide.test.tsx` (the menu),
  `web/test/unit/rooms-lib.test.ts`, `tests/unit/b-rooms-group.test.ts` (one-person channel, group DM reopened),
  `web/test/e2e/private-channels.spec.ts`.
- Version impact: **patch** (words, list placement and a looser create rule; no DB or URL change).

## Follow-ups (2026-11-17, branch fix/private-channel-followups, QA TC-4461, TC-4554)

- **What a guest joins:** any live group room (kind `group`, `server/src/auth/guests.ts` claimGuestRoom,
  `guest-invites.ts` placeAlive): a private channel **or** a group DM. So the guest words name the kind where it is
  known and both where it is not: a named place says "private channel" (`guest.inRoom`, `guest.admin.room`,
  `guest.join.room`, `guest.invite.whereRoom`, `guest.invite.msgRoom*`; the server's `placeName` is the room's own name,
  trimmed, so a name there means a private channel); a group DM picked in the app keeps "group chat"
  (`guest.invite.whereRoomGroup`, `guest.invite.msgRoomGroup*`, `guest.admin.roomGroup`); the rule and the "gone"
  lines say "private channel or group chat" (`guest.onePlace`, `guest.onePlaceShort`, the server's `guestOnePlace`,
  `invitePlaceGone`, `guestNoPlaceGone`, `guestNoPlaceLeft`, Admin › Guests, `members.inviteGuestLine`). The place
  picker lists **Private channels** and **Group chats** under two headings.
- **Server guard:** PATCH /api/rooms/:id refuses `""`, spaces or null as the name of a group room that has one (400
  validation, `body.name`), for every member; a group room with no name can still be given one. The hourly room limit
  says "private channels and group chats" when the room being made has a name (`roomChannelLimit`; one count for both).
- **Focus:** New message focuses the people search (`data-autofocus`); Create a channel still focuses the name.
- **Phone header:** the room's mark (lock, #, people) shows before the title at phone width too, 16 px, inside the back
  button's empty right padding; a DM shows none there (the name and the presence dot are enough).
- **zh:** `rooms.newChat` 发消息 (新消息 read as "you have a new message").
- Tests: `tests/unit/b-rooms-group.test.ts` (the guard, the limit's words), `tests/security/lib/rooms-cases.ts`
  (updateRoom), `web/test/unit/guest-walkthrough.test.ts`, `web/test/e2e/guest-invite-people.spec.ts` (two headings),
  `web/test/e2e/private-channels.spec.ts` (focus).
