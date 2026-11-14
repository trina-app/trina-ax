# Message links: copy a message's link, paste it, see the message (link previews)

- Date (UTC): 2026-11-14 17:05 (reviewed 2026-11-15, see "Review notes")
- Branch: `plan/message-link-previews` (plan only); build on `feat/message-link-previews`
- Status: reviewed — ready to implement after step 0
- Where: Team AX core — `shared/src/api/rooms.ts` (link parser, schemas), `server/src/rooms/` (previews, snapshot,
  audience check), `web/src/components/rooms/` (chip, card, menu item, composer choice). Why: rooms, permissions and the
  chat UI are core (docs/REPOSITORY-RULES.md); nothing Trina-only.
- Version impact: minor — a new user-visible feature, two new API routes, one new optional field on `RoomMessage`, one
  nullable column.

## Goal

The owner (2026-11-14) wants Slack's behaviour: copy a message's link, paste it into a room, DM or thread, and the
message shows under it as a card that can be clicked; the link itself shows as a chip with the conversation's name.
For people who may not see the linked message, "the same way as Slack". "똑같이" is read as: **the same behaviour
and structure as Slack; our own English-first wording and our own design tokens and components**
(english-first-not-a-slack-copy).

Today: the app already has message addresses (`/rooms/<id>?m=<message>`, a reply `/rooms/<id>/t/<root>?m=<reply>`,
`web/src/lib/fileMenu.ts messageLink`), opening one scrolls to the message and marks it (`pages/Room.tsx` `?m=`,
`ListRoomMessagesQuery.around`, `bg-accent-soft` flash in `RoomMessages.tsx`), and a link to this app opens inside the
app (`MessageText.tsx RoomLink`, `lib/markdown.ts classifyLink`). Missing: **Copy link** in the message menu, the chip,
the card, the per-viewer previews, and Slack's *Show message* / *Only show link* choice.

## What Slack does (sources)

Confirmed from Slack's help and API docs:

- **Copy link**: desktop, hover a message › ⋮ More actions › *Copy link*; iOS/Android, long-press › *Copy Link to
  Message*. All members and guests, all plans. <https://slack.com/help/articles/203274767-Forward-messages-in-Slack>
- **Format**: `https://<ws>.slack.com/archives/<channel>/p<ts>`; a thread reply adds `?thread_ts=<root>&cid=<channel>`.
  <https://docs.slack.dev/reference/methods/chat.getPermalink/>
- **Paste**: "The message will expand to show a preview, just like when you share other links in Slack." (same page as
  Copy link)
- **Private channel or DM**: when the link points into one, the sender chooses **Show message** or **Only show link**
  (desktop and mobile). (same page)
- **No preview** when the message has **more than five links**, when the same link was shared in that conversation in
  the past hour, or when the viewer turned text previews off.
  <https://slack.com/help/articles/204399343-Share-links-and-set-preview-preferences>
- **Removing a preview**: the sender hovers the preview and clicks ✕ (mobile: long-press the link › *Remove Link
  Preview*); also while writing. (same page; <https://docs.slack.dev/messaging/unfurling-links-in-messages/>)
- **Per-person setting**: Preferences › Messages & media › "Show text previews of linked websites"; admins can limit
  preview detail. (same page; <https://slack.com/intl/en-gb/help/articles/360001502048-Manage-link-previews>)

Not documented by Slack (to be checked by hand in the test workspace, step 0): the card's exact parts (from the owner's
screenshot: avatar, name, date, conversation label, text with its own links, rounded bordered card; the inline chip
with a speech-bubble icon and the conversation's name), where and how the *Show message* / *Only show link* choice
appears in the composer, what a person outside a private channel sees after each choice, a deleted or edited original
after *Show message*, a file in the linked message, a link to a whole channel, where a thread reply's link opens, the
jump-and-flash on click, the phone layout.

**Slack's private case, our way (coordinator decision 2026-11-15, the owner's "권한 없는 거면 똑같이 슬랙이랑 같은
방법으로")**: we implement Slack's sender choice. When the link points into a conversation that some people in the
destination cannot see, the sender is asked before sending: **Only show link** (default, the safe choice) or **Show
message**. *Show message* is an explicit, per-link consent by a sender who can read the original: the server stores a
frozen **snapshot** of it in the new message and everyone in the destination sees that snapshot, marked "Shared by
<sender>". Checked against our rules in "Permissions" below: it is the human-consent pattern we already use when a
person sends something to a wider audience after a warning (`confirmWidening` cards, "대화방에 보내기" with the count of
members who cannot see); the rule that forbids widening ("Nothing read is sent wider", the Team AX connector's
`room_send`) is about an AI acting for the person, and stays: no AI, app or connector path can create a snapshot.

## Behaviour

### Copy link

- New item **Copy link** in a message's ⋮ (hover bar, `moreItems` in `RoomMessages.tsx`) and in its long-press sheet,
  after *Copy*: room, team room, everyone room, group chat, DM, thread reply. Not on event lines, a message still being
  sent (no id yet), a deleted message or a withheld row.
- It copies `messageLink(roomId, messageId, rootId, origin)` with **the team address** (`GET /api/me` `team.address`,
  `lib/team-address.ts`) as origin when there is one, else `location.origin`. Reason: in the desktop app on an office
  network the page origin can be a LAN address (192.168.x.x) nobody else can open. Toast: the existing
  `rooms.menu.linkCopied` "Link copied." (the room menu's Copy link already says it; no new string, as Slack).
- AI chat messages: not in v1 (an AI chat has a chat link `/c/<id>`, no per-message address). See "Out of scope".

### Paste and send

- The link stays in the message exactly as typed (the body is never rewritten; copy and edit give the address back).
- **What is a message link** (`parseMessageLinks` in `shared/src/api/rooms.ts`, pure, used by server and web):
  `https?://<host>/rooms/<uuid7>[/t/<uuid7>]?m=<uuid7>` (extra query parts ignored; ids lower-cased), found with the
  existing address rules of `web/src/lib/textLinks.ts` (where an address ends, trailing punctuation, Hangul after it),
  never a `//` path or `/api/` (the `classifyLink` rules stay first). The server reads ids from any host (ids decide; a
  link of another team names ids this database does not have, so it gets nothing). The web draws a chip or card only for
  a link whose host is the page's origin or the team address (so an old relay name, another team's address or a look-alike
  host stays an ordinary link as today).
- **The sender's choice (Slack's private prompt)**: while the box holds message links into conversation X and the box
  is in conversation Y (or a thread of Y), the web asks the server once per changed set of links
  (`POST /api/rooms/:id/message-links/audience`, debounced 400 ms). For each link the sender can see **and** that some
  person who will read the new message cannot see, one line above the box:
  "Some people here can't see that message." with a two-option control **Only show link** (selected) / **Show
  message**. Choosing *Show message* shows, in place of the line, the card exactly as it will be stored (WYSIWYG
  consent) with ✕ to go back to *Only show link*. No names, no count of who cannot see. More than one such link (rare):
  one line each, max 5. Links everyone here can see, or into Y itself: no line.
  - Sending keeps the default: if the sender never touched the control, the message has only links for those people.
  - The send body says which links to snapshot (`SendRoomMessageBody.showMessages: Uuid7[]`, max 5). The server builds
    the snapshot itself from the original **at send time** with the sender's own rights; an id the sender cannot see,
    or that does not exist, is dropped silently in exactly the same way (no error, no difference: no existence oracle).
    The client never sends snapshot content.
- Up to **5 message links** per message get cards; with more than 5 links of any kind in the message, no cards (only
  chips), as Slack. The same link twice: one card. The 1-hour "already shared here" rule is not copied (it needs a
  history lookup for little gain; a card under every repeat is harmless).
- Editing a message: a link removed by the edit loses its card, snapshot and removal mark; a link added by an edit gets a
  live card for those who can see it but never a snapshot (the choice is only at send; an edit notifies nobody and
  cannot widen). An edit cannot add `showMessages` (strict body).

### How it looks (each viewer, at view time)

For a viewer who **can see** the linked message (live card, whether or not a snapshot exists):

1. **The chip** replaces the address in the text: speech-bubble icon + the conversation's name *as this viewer sees it*
   (`roomNaming`: `#name` for a team room and the everyone room, the other person's name for a DM, the group chat's
   name or its people). A thread reply: "Thread in #name". A link to the conversation the message is in: the same
   chip. Click → opens the message (below). Long press keeps the message menu (existing `RoomLink` rule).
2. **The card** under the message's text (after the text, before files and reactions), one per linked message, in
   link order:
   - author's photo (`Avatar`, 24 px; `AiFace` for an AI answer, the app's face for an app card), name, date-time
     (same format as the timeline), conversation label (`text-xs`, the same words as the chip);
   - the text, rendered by the same `PersonMarkdown` with the original's `mentions` (its own links stay links; mentions
     as marks; a nested message link is a chip but **never a nested card**), clipped to **6 lines** with "Show more"
     that expands in place;
   - files: one compact line "2 files · report.pdf" (`rooms.lastFiles`-style count; an image: its name, no thumbnail in
     v1); a click opens the message, not the file;
   - an AI answer or a shared answer: its text **as `messagesOut` gives it to this viewer** (team-file links the viewer
     cannot open are already reduced there by the room path check); an app card: its plain text (`appPlainText`).
   - Bordered rounded box (`rounded-lg border border-line`, the tokens of the chat cards `AskCard` / `ConnectCard`), no
     shadow, max width 560 px at 1440. The whole card is one button to open the message; the links inside sit above it
     (the `Quote` pattern in `RoomMessages.tsx`: an absolute button under, `[&_a]:relative` on the text).
3. **Live**: an edited original shows its current text with "(edited)" (`rooms.edited`); a deleted original shows the
   card's header and one faint line "This message was deleted" (`rooms.deleted`, the timeline's own words). Changes
   show on the next load of that page (no live push to cards in other rooms; v1).

For a viewer who **cannot see** it and the sender chose **Show message** (snapshot):

- The chip shows the stored label (below) and the card shows the snapshot: author photo and current name (from the
  stored author id via `refsOf`; a deleted account: "Unknown person"), the original's time, the label, the stored
  text, the files line (names only), and a footer line "Shared by {sender}" (`text-xs text-faint`). Clicking opens the
  original: for them it is the room's usual "can't be found" screen, as for any room they are not in. (Step 0: if
  Slack's snapshot card does not open anything for a non-member, we make it not a button for them.)
- The snapshot is **frozen**: an edit of the original does not change it. A **deletion of the original removes it**:
  the card shows "This message was deleted" for everyone (the author's delete is their way to take words back; Slack
  does not document this; learning that a message one has already seen was deleted reveals nothing new).

For a viewer who **cannot see** it and there is no snapshot (*Only show link*, the default; or not in that
conversation, joined after it in a group or DM, a guest outside it, a withheld old answer, a private preview, an
archived or deleted room, an id that does not exist, a link of another team):

- **No card and no chip.** The address stays the plain link it is today (`RoomLink`). Clicking it opens the room's
  usual "can't be found" screen. The server gives nothing for "no access" and "no such message" alike (the preview is
  absent from the message), so the link cannot be used to learn that a conversation or message exists (no existence
  oracle). Step 0 confirms Slack's exact look for this case; if Slack shows a chip like "Private message" we follow it
  with our own words.

### Opening

- Click the chip or the card → the app's router opens `/rooms/<id>?m=<message>` (or the thread with `?m=<reply>`) by
  path, also when the link's host is the team address and the page runs on another origin (desktop app on a LAN
  address); the existing `around` window loads the page around it, scrolls it into the middle and flashes it
  (`bg-accent-soft`, as search and the Inbox do). Same-room links scroll without changing room. On a phone it is the
  same route (the drawer closes). The desktop app and the phone app are the web page, so they get this as is.
- A message that disappeared between view and click: the room opens at its newest messages (existing `around`
  behaviour for an unknown id), no error.

### Removing a preview (sender)

- On the sender's own message, hover the card › ✕ "Remove preview" (phone: long-press the card › "Remove preview").
  The chip stays; only that card goes (live card and snapshot alike), for everyone. Not undoable from the UI (as Slack).
- Stored in the new column (below), set by its own route `POST /api/rooms/:id/messages/:messageId/hide-preview`
  `{ linkedMessageId }`, sender of a person's message only (not AI answers, app cards, shared answers). **Not** through
  the edit route: `EditRoomMessageBody` requires `body` and an edit sets `edited_at`, which would put "(edited)" on the
  message. Removing a snapshot deletes its stored text, not only hides it.
- The per-person "never show previews" setting is **not** in v1 (lean UI; nobody asked).

## Permissions (Slack's model on ours)

| Linked message is in… | Viewer | Sees |
|---|---|---|
| Team room / everyone room the viewer is in, after `seesFrom` (history_from_seq / visible_from_seq) | member | chip + live card |
| Team room the viewer is **not** in (another group's room) | non-member | plain link; snapshot if the sender chose *Show message* |
| Group chat / DM the viewer is in, after their join | member | chip + live card |
| Group chat / DM before the viewer joined, or not theirs | anyone else | plain link; snapshot if chosen |
| A withheld old answer, or a reply in its thread (`room_hidden_answers`) | that member | plain link (a snapshot of an AI answer is never made, below) |
| Unposted private preview, event line | anyone | plain link; never snapshotted |
| Archived room (`rooms.archived_at`) | anyone | plain link; snapshot if made before, unless the original is deleted |
| Deleted message | anyone with a card | card header + "This message was deleted" (live and snapshot) |
| Thread reply | as its root (`seenSeq`, root hidden answers) | chip "Thread in …" + card |
| Guest (guest-invites) | only invited rooms | as a member there; elsewhere plain link or a snapshot shared into a room they are in |
| Owner / admin | no exception | admins never read rooms they are not in (existing rule) |
| Removed member, member who left | as a non-member | plain link from then on; snapshots already shared stay |
| Another team's address / unknown host | anyone | an ordinary outside link (no chip, no card) |

Rules that make it hold:

- **Live cards are decided on the server, per viewer, per request**, inside `messagesOut` (so the timeline, threads,
  `around`, the realtime `room.message` fanout — which already calls `messagesOut` per member — and every other list
  get the same answer) with `canSee` (`server/src/rooms/store.ts`) on the original row with its thread fields, the
  viewer's member row of the original's room (with `has_hidden`), and `rooms.archived_at IS NULL` (`canSee` alone does
  not check archiving; `isRoomMember` does). The title in a chip is computed per viewer, never stored for live cards
  (the room ref token's rule: "a room's name would reach people who are not in it").
- **Snapshots** (the sender's *Show message*), leak boundaries:
  - only what the **sender can read at send time** (`canSee` for the sender, the same check as a live card); built on
    the server from the row, never from the client;
  - **only a person's own message** (`author_kind` user, not an event, not a shared answer, not an app card): an AI
    answer or app card is never snapshotted (an AI answer carries team-file links and its sources' read scope; widening
    it goes through "방에 올리기" and the read-scope rules, not here). For those the choice line does not offer *Show
    message* (only the link goes);
  - text capped at 4,000 characters; files as count + first name only (no contents, no thumbnails, no file ids);
    mentions as names via stored user ids;
  - the label: a team room or the everyone room: `#name` as the sender saw it; a group chat: "Group chat"; a DM: "Direct
    message" — the people in a DM or group chat are not named (their membership is not the destination's business);
  - frozen: no update on edit; removed when the original is deleted, when the sender removes the preview, when the
    message holding it is deleted, or when an edit takes the link out;
  - marked "Shared by {sender}" on the card;
  - never created by an AI, a room app, the Team AX connector (`room_send`), the room AI or an import: only the web
    app's send with `showMessages`;
  - mentions inside a snapshot notify nobody; push, the room list's last line, search and the room AI's context get the
    typed text only (never the snapshot).
- **Push, list line, search, AI**: a message link is shown as the address the person typed (it holds only ids; no
  conversation name, no content). No new text transform (`plainMessageLinks` dropped, see review notes).
- **The audience check** (`message-links/audience`) answers only about links the sender can see; for others it answers
  exactly as for an id that does not exist (left out). Its answer is a yes/no per link ("someone here cannot see it"),
  never names or counts. The sender is in both conversations, so the yes/no tells them little they cannot already work
  out from the member lists; the residual (that some member of Y has a hidden old answer or joined X late) is accepted,
  as the share-to-room dialog already gives a count.

## API

Previews on messages (no extra request for the timeline):

```ts
// shared/src/api/rooms.ts: RoomMessage gains an optional field (older servers omit it; older clients ignore it)
linkPreviews?: {
  roomId: string; messageId: string; rootId: string | null;     // the link's ids, as parsed (the web matches by these)
  place: { kind: RoomKind; name: string; peers: UserRef[] } | { label: string };   // live: roomNaming for this viewer; snapshot: stored label
  author: UserRef | null; authorKind: 'user' | 'ai' | 'app'; app?: RoomAppRef; mentions: MessageMention[];
  createdAt: string; editedAt: string | null; deleted: boolean;
  body: string;                               // '' when deleted; ≤4,000 chars; an AI answer as messagesOut gives it
  files: { count: number; first?: { name: string; kind: string } };
  sharedBy?: UserRef;                         // a snapshot (Show message)
}[]                                           // ≤5, link order; absent when nothing to show
```

- Built by `linkPreviewsFor(db, rows, viewer)` in a new `server/src/rooms/link-previews.ts`, called once per
  `messagesOut` call: parse the page's bodies (skip messages with >5 links of any kind), dedupe across the page, cap
  100 linked ids per call, then **batched** reads: one `SELECT … FROM room_messages WHERE id IN (…)`, one read of the
  viewer's member rows for those rooms (with `has_hidden`) joined to `rooms` for `archived_at`, `canSee` in memory
  (`isHiddenFor` only for `has_hidden` members), `roomNaming` once per distinct room, `refsOf` / `appRefsOf` once,
  one grouped file count. The original AI answers go through the same `messagesOut` text path for the viewer. No
  per-message queries.
- The realtime fanout (`RoomService.messageEvent`) calls `messagesOut` once per member; the originals' rows, names and
  file counts are read once per event and only the per-member `canSee` runs per member.
- Search results (`rooms/search.ts`) do not ask for previews (a flag on the call); the Inbox and threads do.

`POST /api/rooms/:id/message-links/audience` (`auth: 'user'`, owner `B`, `ROOMS` in `shared/src/api/rooms.ts`): the
sender must be a member of `:id` (else 404 as for any room).

```ts
body:     { links: { roomId: Uuid7; messageId: Uuid7 }[] /* 1..5, deduped */; threadRootId?: Uuid7 }.strict()
response: { items: { messageId: string; someoneCannotSee: true; snapshotAllowed: boolean }[] }   // only links that need the choice
```

- Audience = the active members of `:id` who see the destination (for a thread, who see `threadRootId`), guests
  included, the sender excluded. A link the sender cannot see, a missing one and one everyone can see are all simply
  absent. POST keeps ids out of access logs; CSRF header as every other POST.
- Rate limit: an in-memory per-person token bucket in `rooms/service.ts` like `sendBudget` (`SEND_BURST`), 30 then one
  a second; 429 → the web treats it as "no choice needed" and sends only links (fails safe).

`POST /api/rooms/:id/messages/:messageId/hide-preview` `{ linkedMessageId: Uuid7 }.strict()` → the updated
`RoomMessage` (a `room.message.updated` event; `edited_at` untouched). The author of a person's message only; 404 as
for a message that is not theirs.

`SendRoomMessageBody.showMessages?: Uuid7[]` (max 5): which links to snapshot; ids not in the body's links, not
visible to the sender or not a person's message are dropped silently.

Storage: migration **`402_b_room_message_link_previews.sql`** (the next free number in B's 400–499 range on `dev` at
review time, 2026-11-15: `400_b_chat_files`, `401_b_room_app_presets` exist; no open PR or remote branch uses 402. If
taken at merge time, the later branch renumbers, docs/WORKPLAN.md §4): one nullable column
`room_messages.link_previews TEXT` (JSON `{ hidden?: Uuid7[]; snapshots?: Snapshot[] }`), added to `MSG_COLS`. Additive,
old builds ignore it. Account cleanup: a snapshot holds the author's and sender's user ids only (names come from `refsOf`
at view time), so a deleted account shows as "Unknown person" with nothing to scrub.

## UI spec

- New shared components in `web/src/components/rooms/`: `MessageLinkChip.tsx`, `MessageLinkCard.tsx`, and the composer
  line `MessageLinkChoice.tsx`. Reuse `Avatar`, `AiFace`, `RoomIcon`, `PersonMarkdown`, `MenuButton`, the type tokens
  (`text-reading`, `text-xs`); no raw `text-[..px]`, no new sizes (shared-ui-components-first). No client cache: the
  previews arrive with the messages.
- Used wherever a person's message is drawn: the timeline and `ThreadPanel` (both `RoomMessages.tsx`), the side chat's
  quoted message (`SideChatPanel.tsx`, chip only, no card: it is a one-line quote) and the image viewer's column
  (`ViewerColumn.tsx`, chip only). The composer line lives in `RoomComposer.tsx` (room box and thread box).
- 1440: card max width 560 px. 390: full message width, the label line drops the conversation label first, the date
  stays; the choice control wraps under its sentence. Light and dark from the theme tokens only. Focus ring on the card
  button, the chip and the choice control.
- Screen-reader name of the card: "Message from {name} in {place}, {time}".
- Strings (en is the source; ko, id, ja, es, zh translated; `bun run check:i18n`). Reused, no new key: Copy link
  (`rooms.menu.copyLink`), "Link copied." (`rooms.menu.linkCopied`), "(edited)" (`rooms.edited`), "This message was
  deleted" (`rooms.deleted`), "Unknown person" (`rooms.goneUser`). New:
  `rooms.link.threadIn` "Thread in {name}", `rooms.link.dm` "Direct message", `rooms.link.group` "Group chat",
  `rooms.link.cardLabel` "Message from {name} in {place}, {time}", `rooms.link.showMore` "Show more",
  `rooms.link.files` "{n, plural, one {# file} other {# files}}", `rooms.link.removePreview` "Remove preview",
  `rooms.link.someoneCannotSee` "Some people here can't see that message.", `rooms.link.onlyLink` "Only show link",
  `rooms.link.showMessage` "Show message", `rooms.link.sharedBy` "Shared by {name}".
- Lean check: the message gains at most one card per link and nothing else; no new buttons in the hover bar (Copy link
  sits inside ⋮); the composer gets one line only when a choice is needed, nothing otherwise.

## Steps

0. In the Slack test workspace, by hand: screenshots of a public-channel link, a private channel and DM link with *Show
   message* and *Only show link* (the prompt itself, then seen as a member and as a non-member), an edited and a deleted
   original after *Show message*, a reply link, a file message, a channel link, more than five links, desktop and
   phone. Fill the "not documented" list above; adjust only where Slack differs from this plan.
1. `shared`: `parseMessageLinks`, `RoomMessage.linkPreviews`, `showMessages` on the send body, the audience and
   hide-preview schemas and endpoints; unit tests.
2. `server`: migration 402 (renumber if taken), `rooms/link-previews.ts` (`linkPreviewsFor`, `snapshotFor`), wired into
   `messagesOut` and the fanout; snapshot at send in `Rooms.send` (web send only), dropped on delete/edit; the audience
   route with its bucket; the hide-preview route.
3. `web`: Copy link item (team address origin); chip in `RoomLink` when a preview exists for that link; card; the
   composer choice; remove preview.
4. Docs: a DECISIONS.md section (the snapshot rule and its boundaries, why it does not contradict "Nothing read is sent
   wider"); `changes/message-link-previews.md`; the rooms user docs page.
5. Review: product reviewer (cut), security review of `link-previews.ts`, the audience route and the snapshot before
   merge, ui-polish + impeccable pass (every room kind × owner/admin/member/guest × 1440/390 × light/dark).

## Tests

- Unit (`tests/unit/message-links.test.ts`): parser — top-level, reply, extra query, other host, `//`, `/api/`, http vs
  https, trailing punctuation, Hangul right after, inside a Markdown link, inside a quote, >5 links, duplicates,
  uppercase UUID, not-uuid7.
- Unit (`tests/unit/room-link-previews.test.ts`), permission matrix on a real db: every row of the table above,
  including a later member of a group (before/after join), team room history open/not yet open, hidden answer and its
  thread reply, deleted, event line, private preview, guest, admin outside, removed member, archived room; the message
  for a no-access link and a missing link is byte-identical (`linkPreviews` absent); query count per page is constant
  (no N×M growth: 50 messages × 5 links).
- Unit (`tests/unit/room-link-snapshots.test.ts`): snapshot only with `showMessages` from the web send; never for a link
  the sender cannot see (dropped exactly like a missing id); never for an AI answer, app card, shared answer, event or
  private preview; label words per kind; 4,000 cap; files names only; frozen on edit; gone on original delete, on
  hide-preview, on an edit that removes the link; mentions in it notify nobody; push / last line / search / room-AI
  context never contain snapshot text; `room_send` (connector) and room apps cannot set it (strict bodies).
- Server route tests: audience (1..5, dedupe, membership 404, thread audience, yes/no only, 429 bucket, CSRF, strict);
  hide-preview (author only, `edited_at` unchanged, event sent).
- Security matrix: `tests/security/lib/rooms-cases.ts` — the world's `C.dmMsg` (alice + erin): a room message
  linking it is listed for everyone in that room, and `leaks()` finds the DM text and name only for alice and erin
  (owner and admin included in "everyone else"); `roomMessageLinkAudience` with scope `room-dm` semantics; a probe that a
  nonexistent id and a no-access id give byte-identical answers on both the list and the audience route; frank (outside
  the DM) sending `showMessages: [dmMsg]` into the group chat stores no snapshot.
- Web unit: chip label per room kind; card clip and Show more; deleted card; snapshot footer; nested link never nests a
  card; choice line default and toggle.
- E2E (`web/test/e2e/room-message-links.spec.ts`, `rooms-mock.ts`): copy link from ⋮ and from the phone sheet; paste and
  send; chip + card; click scrolls and flashes; thread reply opens the thread; non-member sees a plain link; the choice
  line, *Show message* then a non-member sees the snapshot; deleted original; >5 links no cards; remove preview;
  screenshots 1440/390 light/dark into `SHOTS_DIR`.
- Checks: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:unit` (rooms + security, also
  under Bun 1.3.12), the full web e2e (shared message rendering changes).

## QA cases (one row each, English, QA tab)

1. Copy link from a room message's ⋮ menu copies `<team address>/rooms/<id>?m=<msg>` and shows "Link copied."
2. Copy link from the phone long-press sheet (390) copies the same address.
3. Copy link on a thread reply copies the thread address with `?m=<reply>`.
4. Copy link in the desktop app on an office network copies the team address, not the LAN address.
5. Pasting a link to a message of the same team room shows the chip "#room" and a card with photo, name, time, text.
6. A link to a DM message pasted into a team room: a member who is in that DM sees the card.
7. A link to a DM message pasted into a team room with "Only show link": a member not in the DM sees a plain link.
8. A link to a group-chat message: a member who joined after the message sees a plain link.
9. A link to a team room message: a member outside that group clicks the plain link and sees "can't be found".
10. Owner/admin not in the linked room sees a plain link (no admin exception).
11. A guest sees a card only for messages in rooms they were invited to.
12. Clicking the card opens the room at the message, centred and flashed.
13. Clicking a reply's card opens the thread at that reply, flashed.
14. A link to a message far back in history opens via the around-window (no endless scroll).
15. Editing the original changes the live card text after reload and shows "(edited)".
16. Deleting the original shows "This message was deleted" in the live card.
17. A message with more than 5 links shows no cards (chips only).
18. The same link twice in one message shows one card.
19. Long linked text is clipped at 6 lines with "Show more".
20. A linked message with files shows the files line; clicking opens the message, not the file.
21. A linked message that itself contains a message link shows a chip, not a nested card.
22. The sender removes a preview; it disappears for everyone; the chip stays; the message shows no "(edited)".
23. The composer shows "Some people here can't see that message." when a reader of the room cannot see the link.
24. The composer shows no line when everyone in the room can see the linked message.
25. Sending without touching the choice sends only the link (a non-member sees a plain link).
26. "Show message": a member not in the linked conversation sees the snapshot card with "Shared by <sender>".
27. A snapshot of a DM shows the label "Direct message", not the people in it.
28. Editing the original after "Show message" does not change the snapshot.
29. Deleting the original after "Show message" shows "This message was deleted" in the snapshot card.
30. A link to an AI answer in a private room offers no "Show message" (only the link goes).
31. A push notification for a message with a message link shows the typed address, never the linked room's name or text.
32. The room list's last line for such a message shows the typed address, never the linked text or a snapshot.
33. ⌘K search does not find a message by the text of a snapshot inside it.
34. A link with another team's address is an ordinary outside link (no chip, no card).
35. Dark theme at 1440: chip, card and choice line follow the theme tokens.
36. Phone width 390 (light): card fits the message width with no horizontal scroll.
37. All six languages show the new strings (en, ko, id, ja, es, zh).
38. iOS app: tapping a chip or card opens the message inside the app.
39. Android app: tapping a chip or card opens the message inside the app.
40. Desktop app: chip/card opens the message inside the app, not the system browser.

## Risks

- **Data leak** (main risk): live cards per viewer on the server inside `messagesOut`, identical absence for no-access and
  missing, snapshots only by an explicit sender choice with the boundaries above; the security matrix and an
  independent security review before merge.
- **Snapshot is a real copy**: once shown, people outside the original conversation have read it. Mitigated by the
  default (*Only show link*), the WYSIWYG preview before sending, the "Shared by" mark, and removal on the original's
  deletion. Owner to confirm the deletion rule after step 0 if Slack differs.
- **Address differences**: links copied with the team address; the server matches ids on any host, the web draws chips
  only for the page origin or the team address. A team that changes its address: old links become plain links (they
  still open through the relay's redirect).
- **Load**: previews are built per page in batch (constant queries per page, cap 100 linked ids), and once per realtime
  event for the shared reads; the audience route is debounced and bucketed.
- **Phone app**: no store build needed (web view); long press must not open the card (existing `RoomLink` rule extended
  to the card).
- **Markdown in people's messages**: the chip goes through the same `PersonMarkdown` link path. A labelled Markdown
  link `[text](message link)` keeps the person's label (no chip) and still gets the card; only a bare address becomes
  a chip.
- Migration: one nullable column; old builds ignore it; the number may need a change at merge (others merge fast).

## Out of scope

- AI chat messages (no per-message address today) and previews of chat links `/c/<id>` (coordinator 2026-11-15: a
  later step, by the same per-viewer rule); links to a whole room (`/rooms/<id>` from the room menu's Copy link);
  Forward; a per-person "no previews" setting; the 1-hour repeat rule; image thumbnails inside the card; snapshots on
  edit; live updates of cards in other rooms; previews of other websites (needs SSRF rules).
- Links in Slack via the Slack connector.

## Review notes (independent plan review, 2026-11-15)

Verified against `origin/dev` (34ab658f2): `messageLink`, `canSee`/`seenSeq`/`seesFrom`/`isHiddenFor`, `roomNaming`,
`refsOf`, `appRefsOf`, `messagesOut`, `RoomLink`, `classifyLink`, `Quote`, `appPlainText`, `PersonMarkdown`,
`ThreadPanel`, `SideChatPanel`, `ViewerColumn`, `lib/team-address.ts`, `EditRoomMessageBody`, `GET /api/room-messages`,
the security world (`C.dmMsg`, `leaks()`), `rooms-mock.ts` exist and do what the plan says, except where changed:

1. **Show message added** (coordinator decision 1): sender choice with *Only show link* default, server-built frozen
   snapshot, boundaries listed under Permissions. DECISIONS.md has no rule forbidding a person's consented widening; the
   human-consent pattern exists (`confirmWidening`, "대화방에 보내기"). The "Nothing read is sent wider" rule binds AI /
   connector sends, so snapshots are web-send only. Added: no snapshot of AI answers, app cards or shared answers (they
   carry file links and read scope; widening them has its own path); DM/group labels name the kind, not the people;
   snapshot removed when the original is deleted (stricter than "frozen" for deletions only).
2. **Previews moved into `messagesOut`** instead of a client-called `POST /api/room-messages/resolve` + web cache. The
   realtime fanout already runs `messagesOut` per member, so every list and event gets per-viewer previews with no
   extra round trip, no client cache invalidation (the old plan's cache missed membership and history changes), and
   no general id-probing endpoint to rate-limit. Batched per page (constant queries).
3. **AI answers in a card** go through `messagesOut`'s per-viewer path check (the old plan would have returned the raw
   body, which can hold team-file links the viewer cannot open).
4. **Archived rooms**: `canSee` does not check `archived_at`; the resolve must (as `isRoomMember` does).
5. **Remove preview** gets its own route: the edit route needs `body` and sets `edited_at` ("(edited)" would appear).
6. **Copy link uses the team address**: `messageLink` defaults to `location.origin`, which in the desktop app on an
   office network is a LAN address others cannot open. Chip/card clicks route by path also for team-address links.
7. **Parser**: server reads ids from any host (it cannot know the page origin); the web filters by origin/team address.
8. **Rate limit**: `auth/rate-limit.ts` is the DB-backed sign-in limiter, not an in-memory one; use the `sendBudget`
   token-bucket style in `rooms/service.ts`, and only on the audience route.
9. **Dropped `plainMessageLinks`** and its string: the typed address holds only ids, so push / list / search showing it
   leaks nothing; less code and no server-side localisation. Snapshot text never reaches them.
10. **Strings**: reuse `rooms.menu.copyLink`, `rooms.menu.linkCopied`, `rooms.edited`, `rooms.deleted`,
    `rooms.goneUser`; new keys under `rooms.link.*` (the old `rooms.menu.copyMessageLink` sat in the room menu's
    namespace). The long toast "Only people in this conversation can open it." dropped (Slack says "Link copied.").
11. **Card look**: there is no rounded "quote card" in threads (`Quote` is a left border); the card uses the
    `rounded-lg border border-line` tokens of the chat cards (`AskCard`, `ConnectCard`).
12. **Migration**: `402_b_room_message_link_previews.sql`, one JSON column for removals and snapshots (was
    `hidden_previews`, number unspecified).
13. **Thread audience**: the composer check takes `threadRootId` (who sees the destination thread).
14. **QA**: split multi-assertion rows (old 5, 21, 25, 27), added Copy link origin, snapshot (26–30), the no-"(edited)"
    check and search; 40 rows, one case each.

## Result

Filled in at the end.
