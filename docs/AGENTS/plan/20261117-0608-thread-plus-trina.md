# A thread and the ✦ side chat open together, and the side chat knows the thread

- Date (UTC): 2026-11-17 06:08
- Branch: `feat/thread-plus-trina`
- Status: in progress
- Where: trina-ax `web/src/pages/Room.tsx`, `web/src/components/rooms/` (`RoomSideColumn.tsx`, `SideChatPanel.tsx`),
  `web/src/components/rail/` (when the list folds), `web/src/components/chat/Messages.tsx` (the question's bubble),
  `shared/src/api/rooms.ts` (the thread line of a question), `server/src/chat/prompt.ts` (one line of the side panel's
  instructions). Why: rooms, threads and the side chat are core (docs/REPOSITORY-RULES.md); nothing is Trina-only.
- Version impact: minor. A visible change of the room page. No new endpoint, no migration, no new stored field.

## Goal

Today the room's right column shows one thing: a thread or my ✦ side chat. Opening ✦ while a thread is open closes
the thread, so a person who wants the AI's help with a thread cannot see the thread while they ask
(docs/DECISIONS.md "Trina side chat": "one of the two at a time"; "The room's right column"). The cause is one slot:
`pages/Room.tsx` draws `threadId ? thread : sideOpen ? side chat : nothing`, an effect closes the side chat when a
thread opens, and ✦ closes the thread before it opens.

The owner wants them side by side: the room, the thread, and the side chat as its own column on the right. And the
side chat's box says it is looking at that thread (a small chip with ✕), so "summarise this" or "draft a reply" is
about the thread without the person quoting anything. The idea is Slack's; the words and the layout are ours.

## What the person sees

Widths below are of the **room page's row** (the window less the rail, the conversation list when it shows, and a file
preview panel when one is open), measured on the page itself, not the window.

| Row | What shows | Example windows |
|---|---|---|
| 1060 px or more | **room, thread, side chat**: three columns | 1440 (row 1080); 1280 once the list folds (row 1208) |
| under 1060, window 812 or more | **thread, side chat** side by side; the room waits under them | 1024 (row 952); the desktop app's smallest window, 900 (row 828) |
| window 768 to 811 | one panel as a sheet over the room (as today); with both open the side chat is on top | |
| phone, under 768 | one panel, the whole screen (as today); with both open the side chat is on top | 390 |

**Three columns.** The room keeps at least 420 px (as beside a thread today), each panel at least 320. Both panels
default to `clamp(320, (row − 420) / 2, 400)`: 330 each in a 1080 row, 400 each from a 1220 row. The divider between
the room and the thread stays (the width it remembers, `THREAD_PANEL`, limits as today within what the side chat
leaves). With only one panel open nothing changes: 400 px (440 from 1280), its divider, the same remembered width.

**What gives when three do not fit (the choice).** In this order:

1. **The conversation list folds away** while both panels are open and the window is under 1420 px
   (72 rail + 288 list + 1060). The list already folds by itself below 1052 px while a thread, the side chat or a file
   preview is open (`rail/railPanel.ts`); this is the same rule with a second width for "both open". It comes back when
   either panel closes. The rail and its unread marks stay.
2. **Then the room column gives way**: under a 1060 row, the thread and the side chat share the row half and half
   (each at least 320) and the room waits under them, as it does under a sheet today (not unmounted: its scroll
   place and its box stay). Closing either panel shows the room again beside the other.
3. **Then one panel at a time** (window under 812): the side chat on top of the thread; its ✕ (a phone: ‹) goes back
   to the thread, and the thread's ✕ or ‹ goes back to the room.

Why this order: the person opened ✦ on a thread to read the two together, so those two stay and what they are not
reading goes first. Options not taken: (a) the side chat as a sheet over the thread (hides the thread: the very
problem); (b) three columns under their minimums (a 300 px room and two 300 px panels read badly, and the boxes'
tool rows wrap); (c) folding the list at every width (people watch the list on a big window).

**Phone (390).** One panel at a time, as today. What changes: "Ask ✦ about this" on a message of a thread opens the
side chat **over** the thread, and its ‹ (and Android's Back) returns to the thread, where today it closed the thread
and returned to the room. A thread that opens while the side chat is the one panel (the "View" link under a sent
answer) takes its place, as today, and ✦ brings the chat back.

**Desktop app.** Its window is 1440 wide by default (three columns) and 900 at the smallest (thread and side chat,
414 px each). Its Browser pane and file preview narrow the row like any side panel: the page drops to "thread, side
chat", never under the minimums.

**The context chip.** While a thread is open on the room page, the side chat's box shows one chip on its first row:
an eye, **"Looking at this thread"**, and ✕ (label: "Ask about the whole conversation"). With the chip on:

- the question is sent with one line on top naming the thread: `> 🧵 <who started it> · <when> (thread_id <id> in
  this room)`. This is the form a quoted message already uses (shared `threadRefToken`), with no message text: the
  app sends the id, and **the server decides what is read**: the AI reads the thread with `room_read`, which checks
  on every call that this person is in the room now and sees that thread (joined before it, not deleted). A thread
  they cannot read reads as nothing. No new field, endpoint or migration.
- the bubble shows that line as a small "🧵 Thread · <who>" mark (never the id), like the 📎 mark of a file question;
- answers offer **Send to thread** for that thread first (the existing rule `nearestThreadOf`: the nearest question
  that names a thread decides), and the AI's `post_to_room` goes there too;
- the placeholder reads "Ask Trina about this thread…", and an empty chat offers one starter, **Summarize this
  thread** (the words apps' threads already use), in place of the room's three. The "Looking at <room> with you"
  line of the empty chat is not drawn while the chip is (one line says what is looked at).

✕ takes the chip off for that thread: questions go without the line and are about the room, as today. The chip
comes back when another thread opens (or this one is opened again). A message quoted with "Ask ✦ about this" takes
the chip's place while its quote card shows (the quote names its own thread). No chip for a guest whose AI cannot
read the room, or for a message that cannot have a thread.

The server's side panel instructions gain one line: a question that starts with `> 🧵` was asked while that thread
was open beside the chat; "this thread", "this", "here" mean it, read it first; a question without it is about the
room. `looking_at` is unchanged (it already names the open thread when the AI asks). This does not put the screen
into every turn (docs/decisions/20261116-ai-screen-and-shared-tools.md): the line is part of the person's own
question, they see it and can take it off.

**Keyboard and focus.**

- ✦ puts the cursor in the side chat's box (as today); the thread keeps its place and its draft. "Reply in thread"
  puts it in the thread's box (as today) and leaves the side chat alone.
- Tab order follows the screen: room, thread, side chat. Under "thread, side chat" and under a sheet the room is
  inert.
- **Esc.** Where the panels are columns beside the room (three columns, or one panel beside the room), Esc closes
  nothing, as today: there Esc belongs to the mention list, an edit, a menu, an IME. Where panels cover the room
  ("thread, side chat", a sheet), Esc closes one panel per press: the one the focus is in, else the side chat first,
  then the thread; never while a menu or dialog of its own is open (the sheet's existing rule). Focus then goes to the
  panel that stays, or back where it was in the room.
- A screen reader hears two regions, "Thread" and the side chat's name (they have these labels today).

**What is remembered.**

- The thread is in the address, as today (a reload, Back and a link keep it).
- The side chat is open while the page stays in the room and closes when it leaves (as today:
  docs/DECISIONS.md "The side chat opens on a new chat"). A thread opening or closing no longer closes it, except
  where only one panel fits.
- The chip taken off: per room and thread, for this page's session (`store/sideChats.ts`, with the draft and quote).
- Widths: the thread's remembered width, per browser, as today.

**Not added (lean).**

- No second divider: the side chat's width is not resizable while a thread is beside it.
- No tabs, no "swap columns", no button to put the chip back (open the thread again, or quote a message).
- No new setting, no new persisted state, no reopening of the side chat after a reload.
- No thread picker in the chip and no chip in the full chat (`/c/<id>`) or in the file viewer.
- The file viewer's column stays one thing at a time (thread or side chat, "Back to the thread"): a fixed 400 px
  column over the picture has no room for two.

**The file viewer and the meeting-notes card.**

- File viewer: unchanged rules. It starts on the side chat when the room page has it open (now also when a thread is
  open beside it), else on the file's thread. Closing it no longer needs to hand the column back: both stay as they
  were on the page.
- File preview panel (beside the page): "Ask ✦ about this file" opens the side chat with the file quoted and no
  longer closes the thread; the quote takes the chip's place.
- Meeting-notes card (desktop app, `components/MeetingNotes.tsx`): fixed to the window's bottom right, over whatever
  is there; today that is the thread's or side chat's box when one is open. Checked in the screenshots with the side
  chat as the right column: if the card covers the send button, it moves up by the box's height while a right column
  is open; otherwise no change.

## Scope

In: the room page's layout for both panels (three columns, thread and side chat, one at a time), the list folding rule
for both, the chip and the question's thread line (web, shared parser, one prompt line), the bubble's mark, Esc and
focus, six languages, docs (the feature list and the in-app guide where they say "one at a time"), tests, QA rows.

Out: the AI chat's own answer threads (`/c/<id>/t/<id>`), the file viewer's column, a resizable side chat beside a
thread, the mobile app's native screens (it shows the web page).

## Steps

1. `lib/roomColumns.ts`: `roomColumns(row, window)` → `'three' | 'pair' | 'one'` and the widths, with unit tests;
   a small `useElementWidth` for the room page's row.
2. `pages/Room.tsx`: draw the thread and the side chat together; ✦, the ask hint, "Ask ✦ about this" and the file
   preview's ask stop closing the thread; a thread opening closes the side chat only in `'one'`; the pair as a
   sheet over the room; Esc and focus for the pair; Android Back for the side chat over a thread.
3. `RoomSideColumn.tsx`: widths for a panel beside another (`beside`), the pair's halves; `railPanel.ts` /
   `RailColumns.tsx`: the second folding width while both are open.
4. Shared `rooms.ts`: `threadLine(author, when, rootId)`, `sideQuoteOf` → `{ kind: 'thread' }`; `title.ts` keeps
   naming a chat by its question; `prompt.ts` one line.
5. `SideChatPanel.tsx`: `thread` prop (the open thread's root as a seed), the chip, what a send carries, the
   placeholder and starter; `store/sideChats.ts` `chipOff`; `Messages.tsx` the bubble's mark.
6. i18n (en first, then ko, id, ja, es, zh), `changes/thread-plus-trina.md`,
   `docs/decisions/20261117-thread-plus-trina.md`, docs that say "one at a time".
7. Tests, the ui-polish pass (every state at 1440, 1280, 1024 and 390, light and dark, font sizes measured), QA rows.
8. Independent code review, one PR to dev.

## Decisions

New: `docs/decisions/20261117-thread-plus-trina.md` "A thread and the side chat show together; the side chat's chip
names the thread". It changes "one of the two at a time" in the archive's
[Trina side chat](../../DECISIONS.md) and [The room's right column](../../DECISIONS.md) for the room page (the file
viewer's column keeps it), and adds the "both open" width to the nav rail's folding rule
(docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1).

## Risks

- **Open PRs:** #1198 (the mic in `SideChatPanel.tsx`'s box) and #1196 (private channels; server and docs). Merge
  dev in once when they land; the chip sits on the box's first row, above the text, away from the mic's toolbar.
- **Marking read:** the room under the pair has no height in sight, so nothing in it is marked read (the phone's
  rule, `tryRead`); it reads again when a panel closes.
- **A thread line typed by hand:** a person can type `> 🧵 … (thread_id <id> in this room)` for any id; `room_read`
  still checks the id against their membership, so it reads nothing they cannot see.
- **Older chats and other surfaces:** the line is plain text of the question; the full chat shows the same mark, and
  editing a question keeps its thread while the first line is unchanged (`keepThreadRef`).
- **Six languages**, phone and desktop app widths, dark mode. No migration, no permission change.
- Tests that say "✦ closes the thread" (unit and e2e) change with the rule.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`; unit: `web/test/unit`
(`room-columns`, `side-chat`, `side-chat-send`, `room-thread`, `rail`), `tests/unit` (the prompt line, the title, the
shared parser; under Bun 1.3.12); e2e: a new `thread-plus-trina.spec.ts` (three columns at 1440, the list folding at
1280, thread and side chat at 1024, a phone's way back, the chip on, off and back, what a send carries, Send to
thread, Esc, the file preview's ask) and the room, thread, side chat, rail and viewer specs that exist; the full web
e2e before the PR (a shared layout change).

## Result

(filled in at the end)
