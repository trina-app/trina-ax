# Message links: copy a message's link, paste it, see the message (link previews)

- Date (UTC): 2026-11-14 17:05
- Branch: `plan/message-link-previews` (plan only); build on `feat/message-link-previews`
- Status: draft
- Where: Team AX core — `shared/src/api/rooms.ts` (link parser, schemas), `server/src/rooms/` (resolve), `web/src/components/rooms/` (chip, card, menu item). Why: rooms, permissions and the chat UI are core (docs/REPOSITORY-RULES.md); nothing Trina-only.
- Version impact: minor — a new user-visible feature, a new API route and one nullable column.

## Goal

The owner (2026-11-14) wants Slack's behaviour: copy a message's link, paste it into a room, DM or thread, and the
message shows under it as a card that can be clicked; the link itself shows as a chip with the conversation's name.
People who may not see the linked message see what Slack shows them. "똑같이" is read as: **the same behaviour and
structure as Slack; our own English-first wording and our own design tokens and components**
(english-first-not-a-slack-copy).

Today: the app already has message addresses (`/rooms/<id>?m=<message>`, a reply `/rooms/<id>/t/<root>?m=<reply>`,
`web/src/lib/fileMenu.ts messageLink`), opening one scrolls to the message and marks it (`pages/Room.tsx` `?m=`,
`ListRoomMessagesQuery.around`), and a link to this app opens inside the app (`MessageText.tsx RoomLink`,
`lib/markdown.ts classifyLink`). Missing: **Copy link** in the message menu, the chip, the card, and the
per-viewer resolve.

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
with a speech-bubble icon and the conversation's name), what a person outside a private channel sees after *Only show
link*, a deleted or edited original, a file in the linked message, a link to a whole channel, where a thread reply's
link opens, the jump-and-flash on click, the phone layout.

**Our reading of Slack's private case**: Slack lets the sender put a private message's content in front of people who
are not in that conversation (*Show message*). We do **not** copy that half: the card is drawn for each viewer from
what that viewer may read now, so a link never carries content to someone who cannot open it. What we keep is the
moment Slack uses for it: before sending, the sender is told that some people here will only see the link (see
"Sending"). Offering a *Show message* that copies the text across is an open question for the owner, not in v1.

## Behaviour

### Copy link

- New item **Copy link** in a message's ⋮ (hover bar) and in its long-press sheet, after *Copy*: room, team room,
  everyone room, group chat, DM, thread reply. Not on event lines, a message still being sent, or a withheld row.
- It copies `messageLink(roomId, messageId, rootId)` (the existing helper) on the page's origin. Toast, plain words:
  "Link copied. Only people in this conversation can open it." (for a DM/group: the same; the everyone room: "Link
  copied.").
- AI chat messages: not in v1 (an AI chat has a chat link `/c/<id>`, no per-message address). See "Out of scope".

### Paste and send

- The link stays in the message exactly as typed (the body is never rewritten; copy and edit give the address back).
- **The sender's hint (Slack's private prompt, our way)**: while the box holds a message link to conversation X and the
  box is in conversation Y, if some members of Y cannot see that message, one quiet line above the box: "Some people
  here can't see that message. They'll only see the link." No buttons, no names, no count. Computed by the same
  resolve call with `audienceRoomId` (below); hidden when everyone can see it or X = Y.
- Up to **5 message links** per message get cards; with more than 5 links of any kind in the message, no cards (only
  chips), as Slack. The same link twice: one card. The 1-hour "already shared here" rule is not copied (it needs a
  history lookup for little gain; a card under every repeat is harmless).

### How it looks (each viewer, at view time)

For a viewer who **can see** the linked message:

1. **The chip** replaces the address in the text: speech-bubble icon + the conversation's name *as this viewer sees it*
   (`roomNaming`: `#name` for a team room and the everyone room, the other person's name for a DM, the group chat's
   name or its people). A thread reply: "Thread in #name". A link to the conversation the message is in: the same
   chip. Click → opens the message (below). Long press keeps the message menu (existing `RoomLink` rule).
2. **The card** under the message's text (after the text, before files and reactions), one per linked message, in
   link order:
   - author's photo (24 px; the app's face for an app or AI answer), name, date-time (same format as the timeline),
     conversation label (12 px, the same words as the chip; "Thread" for a reply);
   - the text, rendered by the same `PersonMarkdown` (its own links stay links; mentions as marks; a nested message
     link is a chip but **never a nested card**), clipped to **6 lines** with "Show more" that expands in place;
   - files: one compact line "📎 2 files · report.pdf" (an image: its name, no thumbnail in v1); a click opens the
     message, not the file;
   - an AI answer shared to a room: its Markdown, same clip; an app card: its plain text (`appPlainText`).
   - Bordered rounded box (`border-line`, the card radius already used for quotes in threads), no shadow. The whole
     card is one button to open the message; the links inside sit above it (the `Quote` pattern in
     `RoomMessages.tsx`).
3. **Live, not a snapshot**: an edited original shows its current text with "(edited)"; a deleted original shows the
   card's header and one faint line "This message was deleted." (the timeline's own words). Justification vs Slack:
   Slack's *Show message* behaves like a copy taken when sent; ours is read each time with the viewer's own rights, so
   a deletion or a removed member is honoured at once and nothing is stored twice. This is the only way the "no leak"
   rule holds.

For a viewer who **cannot see** it (not in that conversation, joined after it in a group or DM, a guest outside it,
a withheld old answer, a private preview, a room that is gone, an id that does not exist, a link of another team):

- **No card and no chip.** The address stays the plain link it is today (`RoomLink`). Clicking it opens the room's
  usual "can't be found" screen. The answer from the server is the same for "no access" and "no such message", so the
  link cannot be used to learn that a conversation or message exists (no existence oracle).
- This matches Slack's *Only show link* (the default we use for every private case). Step 0 confirms Slack's exact
  look for this case; if Slack shows a chip like "Private message" we follow it with our own words.

### Opening

- Click the chip or the card → the app's router opens `/rooms/<id>?m=<message>` (or the thread with `?m=<reply>`); the
  existing `around` window loads the page around it, scrolls it into the middle and flashes it (`bg-accent-soft`, as
  search and the Inbox do). Same-room links scroll without changing room. On a phone it is the same route (the drawer
  closes). The desktop app and the phone app are the web page, so they get this as is.
- A message that disappeared between view and click: the room opens at its newest messages (existing `around`
  behaviour for an unknown id), no error.

### Removing a preview (sender)

- On the sender's own message, hover the card › ✕ "Remove preview" (phone: long-press the card › "Remove preview").
  The chip stays; only that card goes, for everyone. Not undoable from the UI (as Slack); editing the message keeps the
  removal for links still there.
- Stored as `room_messages.hidden_previews` (nullable JSON array of message ids, max 5). One small migration (next free
  number on `dev` at build time), no new table. The per-person "never show previews" setting is **not** in v1 (lean
  UI; nobody asked).

## Permissions (Slack's model on ours)

| Linked message is in… | Viewer | Sees |
|---|---|---|
| Team room / everyone room the viewer is in, after `history_from_seq` | member | chip + card |
| Team room the viewer is **not** in (another group's room) | non-member | plain link (Slack: private channel, *Only show link*) |
| Group chat / DM the viewer is in, after their join | member | chip + card |
| Group chat / DM before the viewer joined, or not theirs | anyone else | plain link |
| A withheld old answer, or a reply in its thread (`room_hidden_answers`) | that member | plain link |
| Unposted private preview, event line | anyone | plain link |
| Deleted message the viewer could see | member | card header + "This message was deleted." |
| Thread reply | as its root (`seenSeq`) | chip "Thread in …" + card |
| Guest (guest-invites) | only invited rooms | as a member there, plain link elsewhere |
| Owner / admin | no exception | admins never read rooms they are not in (existing rule) |
| Another team's address / unknown origin | anyone | an ordinary outside link (no chip, no card, no request) |

Rules that make it hold:

- **Everything is decided on the server, per viewer, per request** with the existing `canSee` / membership code
  (`server/src/rooms/store.ts`). The sender's message stores only the address. The title in a chip is never stored
  (the room ref token's rule: "a room's name would reach people who are not in it").
- The resolve answers `{ ok: false }` for every case the viewer cannot see, with the same shape and timing class as
  "not found" (no `reason` field).
- Push notifications, the room list's last line, ⌘K snippets and the AI's view of the message see a message link as
  "a message link" text (new `plainMessageLinks`, like `plainRoomRefs`): no conversation name, no content.
- The composer hint's check (who in Y cannot see X) uses only membership of rooms the sender is in; it returns a
  yes/no, never names or counts.

## API

`POST /api/room-messages/resolve` (`auth: 'user'`, owner `B`, in `shared/src/api/rooms.ts` `ROOMS`; `/api/room-messages`
already exists for search, so no clash with `/api/rooms/:id`):

```ts
body:     { links: { roomId: Uuid7; messageId: Uuid7; rootId?: Uuid7 }[] /* 1..50, deduped */; audienceRoomId?: Uuid7 }
response: { items: ({ messageId: string; ok: false } | {
              messageId: string; ok: true;
              room: { id; kind; name; peers; memberCount };   // roomNaming for this viewer
              threadRootId: string | null;
              message: { authorKind; author: UserRef | null; app?: RoomAppRef; createdAt; editedAt; deleted: boolean;
                         body: string /* '' when deleted */; sharedAnswerAt?: number;
                         files: { count: number; first?: { name: string; kind: string } } };
              hiddenFor?: boolean /* audienceRoomId given: someone there cannot see it */ })[] }
```

- POST, not GET: ids stay out of access logs and URLs; CSRF header as every other POST.
- One batch per timeline page: the web collects message links of the messages it renders (`parseMessageLinks`, ≤5
  per message) and resolves them in one call, max 50 per request, deduped across the page.
- `body` is capped server-side at 4,000 characters (the card shows 6 lines; "Show more" opens the message if longer).
- Rate limit: 120 requests per user per minute (in-memory, the `auth/rate-limit.ts` style), 429 otherwise; the web
  backs off and shows plain links.
- Caching: none on the server (indexed SQLite lookups; `no-store`). Web: a per-session map keyed by message id,
  dropped on the room's existing message edit/delete events for rooms the viewer is in, and on room membership
  changes (leave, removed, joined); otherwise refreshed when the timeline reloads.
- The parser lives in `shared/src/api/rooms.ts` (`parseMessageLinks(text, origins)`): accepts
  `https?://<origin>/rooms/<uuid7>[/t/<uuid7>]?m=<uuid7>` with extra query parts ignored, only for the page's origin
  and the team's address (`web/src/lib/team-address.ts`), never for `//` paths or `/api/` (the `classifyLink` rules
  stay first). Pure, unit-tested; the server re-validates ids with its schema.

## UI spec

- New shared components in `web/src/components/rooms/`: `MessageLinkChip.tsx`, `MessageLinkCard.tsx`, plus a
  `useMessageLinks(messages)` hook (batch + cache). Reuse `Avatar`, `RoomIcon`, `PersonMarkdown`, `MenuButton`, the type
  tokens (`text-reading`, `text-xs`); no raw `text-[..px]`, no new sizes (shared-ui-components-first).
- Used by the timeline, threads (`ThreadPanel`), the side chat's quoted message and the image viewer's column wherever
  `PersonMarkdown` draws a person's message.
- 1440: card max width 560 px. 390: full message width, the label line drops the conversation label first, the date
  stays. Light and dark from the theme tokens only. Focus ring on the card button and the chip.
- Screen-reader name of the card: "Message from {name} in {conversation}, {date}".
- Strings (en is the source; ko, id, ja, es, zh translated; `bun run check:i18n`):
  `rooms.menu.copyMessageLink` "Copy link", `rooms.messageLinkCopied` "Link copied. Only people in this conversation
  can open it.", `rooms.linkThreadIn` "Thread in {name}", `rooms.linkDm` "Direct message with {name}",
  `rooms.linkCardLabel` "Message from {name} in {place}, {time}", `rooms.linkShowMore` "Show more",
  `rooms.linkFiles` "{n, plural, one {# file} other {# files}}", `rooms.linkRemovePreview` "Remove preview",
  `rooms.linkHint` "Some people here can't see that message. They'll only see the link.", `rooms.messageLinkText`
  "a message link" (push, list line, search).
- Lean check: the message gains at most one card per link and nothing else; no new buttons in the hover bar (Copy link
  sits inside ⋮); the hint is one line without buttons.

## Steps

0. In the Slack test workspace, by hand: screenshots of a public-channel link, a private channel and DM link with *Show
   message* and *Only show link* (seen as a member and as a non-member), an edited and a deleted original, a reply
   link, a file message, a channel link, more than five links, desktop and phone. Fill the "not documented" list above;
   adjust only where Slack differs from this plan.
1. `shared`: `parseMessageLinks`, `plainMessageLinks`, the resolve schemas and endpoint; unit tests.
2. `server`: `rooms/link-previews.ts` (`resolveLinks(db, viewer, links, audienceRoomId)` on `canSee`, `roomNaming`,
   `refsOf`, `appRefsOf`), the route, the rate limit; `hidden_previews` migration + `PATCH` on the existing edit route
   (`EditRoomMessageBody.hidePreview`, sender only); `plainMessageLinks` in push text, last message and search snippet.
3. `web`: Copy link item; chip in `RoomLink` when the link resolves; card; batch hook; composer hint; remove preview.
4. Docs: a DECISIONS.md section; `changes/message-link-previews.md`; user docs page for rooms if one mentions links.
5. Review: product reviewer (cut), security review of the resolve route before merge, ui-polish + impeccable pass
   (every room kind × owner/admin/member/guest × 1440/390 × light/dark).

## Tests

- Unit (`tests/unit/message-links.test.ts`): parser — top-level, reply, extra query, other origin, team address, `//`,
  `/api/`, http vs https, trailing punctuation, Hangul right after, inside Markdown link, inside a quote, >5 links,
  duplicates, uppercase UUID, not-uuid7.
- Unit (`tests/unit/room-link-previews.test.ts`), permission matrix on a real db: every row of the table above,
  including later member of a group (before/after join), team room history open/not yet open, hidden answer and its
  thread reply, deleted, event line, private preview, guest, admin outside, removed member, archived room; `ok:false`
  identical for no-access and missing; `audienceRoomId` yes/no without names.
- Server route tests: 50 cap, dedupe, 4,000-char cap, 429, CSRF, strict body.
- Security matrix: `tests/security/lib/rooms-cases.ts` gets `resolveRoomMessageLinks` with scope `room-dm` semantics
  (the world's `C.dmMsg`: alice and erin get `ok:true`, everyone else including owner and admin gets `ok:false` with
  no content — checked with `leaks()` for the DM text and the room name), and a probe that a nonexistent id and a
  no-access id return byte-identical items.
- Web unit: chip label per room kind; card clip and Show more; deleted card; nested link never nests a card; cache
  dropped on edit/delete events.
- E2E (`web/test/e2e/room-message-links.spec.ts`, rooms-mock): copy link from ⋮ and from the phone sheet; paste and
  send; chip + card; click scrolls and flashes; thread reply opens the thread; non-member sees a plain link; deleted
  original; >5 links no cards; remove preview; composer hint; screenshots 1440/390 light/dark into `SHOTS_DIR`.
- Checks: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:unit` (rooms + security),
  the full web e2e (shared message rendering changes).

## QA cases (one row each, English, QA tab)

1. Copy link from a room message's ⋮ menu copies `/rooms/<id>?m=<msg>` and shows the toast.
2. Copy link from the phone long-press sheet (390) works the same.
3. Copy link on a thread reply copies the thread address with `?m=<reply>`.
4. Pasting a message link of the same team room shows the chip "#room" and the card with photo, name, time, text.
5. Link to a DM message pasted into a team room: members of that DM see the card, other members see a plain link.
6. Link to a group-chat message: a member who joined after the message sees a plain link.
7. Link to a team room message: a member outside that group sees a plain link; opening it shows "can't be found".
8. Owner/admin not in the room sees a plain link (no admin exception).
9. Guest sees a card only for messages in rooms they were invited to.
10. Clicking the card opens the room at the message, centred and flashed.
11. Clicking a reply's card opens the thread at that reply, flashed.
12. A link to a message far back in history opens via the around-window (no endless scroll).
13. Editing the original changes the card text (after reload) and shows "(edited)".
14. Deleting the original shows "This message was deleted." in the card.
15. A message with more than 5 links shows no cards (chips only).
16. The same link twice in one message shows one card.
17. Long linked text is clipped at 6 lines with "Show more".
18. A linked message with files shows the compact files line; clicking opens the message.
19. A linked message that itself contains a message link shows a chip, not a nested card.
20. Sender removes a preview; it disappears for everyone; the chip stays.
21. Composer hint appears when some members cannot see the linked message, and not otherwise.
22. Push notification and room list show "a message link", never the room name or text.
23. ⌘K search snippet shows "a message link" for such a message.
24. Link with another team's address is an ordinary outside link.
25. Light and dark, 1440 and 390: chip and card follow the theme; no horizontal scroll at 390.
26. All six languages show the new strings (en, ko, id, ja, es, zh).
27. iOS and Android app (web view): chip/card tap opens inside the app.
28. Desktop app: chip/card opens inside the app, not the system browser.

## Risks

- **Data leak** (main risk): mitigated by per-viewer server resolve, no stored names, identical `ok:false`, the security
  matrix and an independent security review before merge.
- **Address differences**: a link copied on the desktop app or a phone on another address of the same team; the parser
  accepts the page's origin and the team address only. A link copied from a local-only address is an ordinary link.
- **Load**: one batch per page, capped; SQLite indexed reads; rate limit.
- **Phone app**: no store build needed (web view); long press must not open the card (existing `RoomLink` rule extended
  to the card).
- **Markdown in people's messages**: the chip goes through the same `PersonMarkdown` link path. A labelled Markdown
  link `[text](message link)` keeps the person's label (no chip) and still gets the card; only a bare address becomes
  a chip.
- Migration: one nullable column; old builds ignore it.

## Out of scope

- AI chat messages (no per-message address today) and previews of chat links `/c/<id>`; a later step can give `/c/<id>`
  a chip with the chat's title for people who can open it, by the same per-viewer rule.
- Slack's *Show message* for private content (open question), Forward, a per-person "no previews" setting, the
  1-hour repeat rule, image thumbnails inside the card, previews of other websites (needs SSRF rules).
- Links in Slack via the Slack connector.

## Result

Filled in at the end.
