# A thread and the ✦ side chat open together, and the side chat knows the thread

- Date (UTC): 2026-11-17 06:08
- Branch: `feat/thread-plus-trina`
- Status: done
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
preview panel when one is open), measured on the page itself, not the window. With both panels open the row alone
decides:

| Row | What shows | Example windows |
|---|---|---|
| 1060 px or more | **room, thread, side chat**: three columns | 1440 and 1280 (the list folds: rows 1368 and 1208); 1512 and up with the list |
| 640 to 1059 | **thread, side chat** side by side; the room waits under them | 1024 (row 952); the desktop app's smallest window, 900 (row 828) |
| under 640 | one panel at a time; the side chat is over the thread | a phone (390); a small window with a file preview beside the page |

With one panel open nothing changes: a column beside the room (400 px, 440 from 1280, its divider and remembered
width), a sheet over the room in a window of 768 to 811 px, the whole screen on a phone.

**Three columns.** The room keeps at least 420 px (as beside a thread today), each panel at least 320. The two panels
share what the room leaves evenly: `clamp(320, (row − 420) / 2, 440)` each: 330 in a 1080 row, 394 at 1208, 440 from a
1300 row. **No divider while both are open** (below, "Not added"); a thread's remembered width is back when the side
chat closes.

**What gives when three do not fit (the choice).** In this order:

1. **The conversation list folds away** while both panels are open and the window is under 1448 px (the rail at its
   widest, 88, the list at its widest, 300, and 1060: so whenever the list shows, three columns fit). The list already
   folds by itself below 1052 px while a thread, the side chat or a file preview is open (`rail/railPanel.ts`); this
   is the same rule with a second width for "both open". It comes back when either panel closes. The rail and its
   unread marks stay. At 1440 this also gives the three columns air: room 568, panels 400 each, where keeping the
   list would leave all three at their minimums.
2. **Then the room column gives way**: in a row under 1060 the thread and the side chat share it half and half and
   the room waits under them, as it does under a sheet today (not unmounted: its scroll place and its box stay; out
   of reach and not marked read meanwhile). Closing either panel shows the room again beside the other.
3. **Then one panel at a time** (a row under 640): the side chat over the thread; its ✕ (a phone: ‹) goes back to the
   thread, and the thread's ✕ or ‹ goes back to the room.

Why this order: the person opened ✦ on a thread to read the two together, so those two stay and what they are not
reading goes first. Options not taken: (a) the side chat as a sheet over the thread (hides the thread: the very
problem); (b) three columns under their minimums (a 300 px room and two 300 px panels read badly, and the boxes'
tool rows wrap); (c) folding the list at every width (people watch the list on a big window).

**Which way the two come together.** The room gives way only when the person asked for the side chat on a thread
(✦, the ask hint, "Ask ✦ about this", the file preview's ask, or a three-column window made smaller). The other way
round, a thread opened from the room while the side chat is open, keeps today's rule where three columns would not
fit even with the list folded: the thread takes the side chat's place (a click in the room must not make the room
disappear), and ✦ brings the same chat back beside it. Where three fit, both stay. A thread that replaces another
while both show (the "View" link under a sent answer) keeps both.

**"View" under a sent answer.** To a thread: it opens in the thread column (through `threadOpening`: in place of the
thread that is open, so the thread's ✕ still steps back to the room once). Where the side chat is over the thread, it
steps aside for it (✦ brings it back). To the room: where the room is under the pair, the side chat stays and the
thread closes so the room shows at the message; on a phone the side chat closes as today.

**A file preview beside the page** (the app's right panel) takes its width first, as today beside a thread (the page
keeps 740 px): with both panels open the page then shows "thread, side chat" and the room waits, also on a wide
window; in a small window (the desktop's 900 with a preview) the page drops to one panel at a time. The list's
folding is not changed by a preview.

**Phone (390).** One panel at a time, as today. What changes: "Ask ✦ about this" on a message of a thread opens the
side chat **over** the thread, and its ‹ (and Android's Back) returns to the thread, where today it closed the thread
and returned to the room. The room's ✦ button is not on screen while a thread fills a phone, so there the side chat
opens on a thread through that ask: the first question carries the quoted message (which names the thread), and the
chip shows for the questions after it.

**Desktop app.** Its window is 1440 wide by default (three columns, the list folded) and 900 at the smallest (thread
and side chat, 414 px each). A file preview narrows the row as above. Its Browser pane narrows the app's own window,
so the page follows the table by the row it is left with.

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

✕ takes the chip off for the thread that is open: questions go without the line and are about the room, as today.
The chip is back when the thread is closed and opened again, or another thread opens. A message quoted with "Ask ✦
about this" takes the chip's place while its quote card shows (the quote names its own thread). No chip for a guest
whose AI cannot read the room, or for a message that cannot have a thread.

**A thread line counts for its own question only.** `nearestThreadOf` (the rule behind Send to thread and
`post_to_room`) today keeps a quoted message's thread for the follow-ups without a quote ("make it shorter"). That
stays for quotes. A thread line does not carry on: the chip puts it on every question while it is on, so a question
without it was asked with the chip off (or the thread closed) and its answer goes to the room. Both copies of the rule
change (shared `nearestThreadOf`, web `sendTargets`). Editing or copying such a question shows the question without
the line; saving the edit keeps the line.

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
  then the thread; never while a menu or dialog of its own is open (the sheet's existing rule), and never while an
  input method composes (Korean, Japanese: Esc there cancels the composition). With a file preview open beside
  "thread, side chat", Esc closes the preview first (the app frame's rule), then the panels. Focus then goes to the
  panel that stays, or back where it was in the room.
- "Thread, side chat" are two labelled regions over an inert room, not two modal dialogs (each would hide the other
  from a screen reader).
- A screen reader hears two regions, "Thread" and the side chat's name (they have these labels today).

**What is remembered.**

- The thread is in the address, as today (a reload, Back and a link keep it).
- The side chat is open while the page stays in the room and closes when it leaves (as today:
  docs/DECISIONS.md "The side chat opens on a new chat"). A thread opening or closing no longer closes it, except
  where only one panel fits.
- The chip taken off: per room and thread, for this page's session (`store/sideChats.ts`, with the draft and quote).
- Widths: the remembered width of a single panel, per browser, as today; nothing new is remembered.

**Not added (lean).**

- No divider while both are open: the two panels share the space evenly. (A divider on the thread alone would save
  its width as a share of a smaller row and change the single panel's width later; two dividers are more than this
  needs.) The remembered width applies again when one closes.
- No tabs, no "swap columns", no button to put the chip back (open the thread again, or quote a message).
- No new setting, no new persisted state, no reopening of the side chat after a reload.
- No thread picker in the chip and no chip in the full chat (`/c/<id>`) or in the file viewer.
- The file viewer's column stays one thing at a time (thread or side chat, "Back to the thread"): a fixed 400 px
  column over the picture has no room for two.

**The file viewer and the meeting-notes card.**

- File viewer: its column stays one thing at a time. It starts on the side chat when the room page shows the side
  chat alone, and on the file's thread otherwise (so a picture opened from the thread beside the side chat starts on
  its thread). Both panels stay as they were on the page under it.
- File preview panel (beside the page): "Ask ✦ about this file" opens the side chat with the file quoted and no
  longer closes the thread; the quote takes the chip's place.
- Meeting-notes card (desktop app, `components/MeetingNotes.tsx`): fixed to the window's bottom right, 352 px wide,
  so today it already sits on the thread's or the side chat's message box when one is open. While a room shows a
  panel on its right, the card sits above that panel's message box (raised by a fixed step, 12rem: the box with its chip is about 185 px high) instead of on it.
  A very tall draft can still reach it; the card folds to one row.

**On the server (no code but one prompt line; recorded in the decision).**

- A side chat already counts as a chat that has read rooms (`read-rooms.ts`), so no card or gate gets looser.
- `quotesAppOnBranch` reads a question's thread id: a chip question about a thread started by an app's card marks the
  chat as holding outside words, as quoting that card does today. Accepted.
- `isQuoteLine` keeps the line out of the person's "own words" (the web address gate, the explicit-ask rules), as
  for a quote.

## Scope

In: the room page's layout for both panels (three columns, thread and side chat, one at a time), the list folding rule
for both, the chip and the question's thread line (web, shared parser, one prompt line), the bubble's mark, Esc and
focus, six languages, docs (the feature list and the in-app guide where they say "one at a time"), tests, QA rows.

Out: the AI chat's own answer threads (`/c/<id>/t/<id>`), the file viewer's column, a resizable side chat beside a
thread, the mobile app's native screens (it shows the web page).

## Steps

1. `lib/roomColumns.ts`: `roomColumns(row)` → `'three' | 'pair' | 'one'`, with unit tests; a small
   `useElementWidth` for the room page's row (read before the first paint).
2. `pages/Room.tsx`: draw the thread and the side chat together; ✦, the ask hint, "Ask ✦ about this" and the file
   preview's ask stop closing the thread; a thread opened from the room takes the side chat's place only where
   three columns would not fit; the pair over the room; Esc and focus for the pair; Android Back for the side chat
   over a thread; "View" through the page (`threadOpening`); a covered thread is not marked read.
3. `RoomSideColumn.tsx`: the width of a panel beside another (`shared`); `railPanel.ts` / `RailColumns.tsx`: the
   second folding width while both are open; `ViewerColumn.tsx` start rule; `MeetingNotes.tsx` raised card.
4. Shared `rooms.ts`: the thread line and its parser, `sideQuoteOf` → `{ kind: 'thread' }`, `nearestThreadOf` (a
   line counts for its own question); web `sendTargets` the same; `title.ts` keeps naming a chat by its question;
   `prompt.ts` one line.
5. `SideChatPanel.tsx`: `thread` prop (the open thread's root as a seed), the chip, what a send carries, the
   placeholder and starter; `store/sideChats.ts` `chipOff`; `Messages.tsx` the bubble's mark, edit and copy.
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
- **Marking read:** a room under panels and a thread under the side chat are out of sight: nothing in them is marked
  read until they show again (`tryRead` in `Room.tsx` and `ThreadPanel.tsx`; the room under a sheet at 768 to 811 px
  was marked read before, which was wrong for the same reason).
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

## Plan review (independent, 2026-11-17)

Verdict: approve with changes. Taken: the mode by the row alone (three, pair, one) and what a file preview does to
it; the folding width from the rail's and the list's widest (1448, not 1420); "View" with the thread already open;
no read marks for a covered thread; Esc with an input method and with a file preview; a thread line counts for its
own question only (so "chip off = the room" is true for where answers go); a thread opened from the room keeps
today's rule where three do not fit; no divider while both are open; edit and copy of a chip question; one rule for
when the chip returns; the phone's way to the chip said plainly; the viewer's start rule; the meeting card's place
decided; the server's side effects written down.

## Code review (independent, 2026-11-17)

Verdict: approve with changes. Fixed: `side-chat-send.spec.ts` asserted the old rule after "View"; at 1280 the first
frame of the two used the row's width from before the list folded (the pair flashed over the room and the keyboard
went into the side chat): the page now reads its row as it draws, with the list's width while it still shows; the
thread that takes the side chat's place does so in the click's own step (no fold of the list in between); the edit
and copy rule of a thread line is a side chat's only; the rail folds only for a real thread address; a hand-off
ends when the person opens or closes the side chat; the chip's ✕ ends with the side chat; a thread whose first
author is gone. Tests added for each, and for Esc while an input method composes, a file preview beside both, one
panel at a time in a small window, the viewer's start rule, the meeting card and a file sent alone with the chip on.

## Result

Built as planned after the review:

- `web/src/lib/roomColumns.ts` (the row decides: three, pair, one), `pages/Room.tsx` (both panels drawn; the pair
  and the side chat over the thread as covers; Esc, focus, read marks, "View", the chip's reset),
  `components/rooms/RoomSideColumn.tsx` (`shared`, `inert`), `components/rail/` (the list folds below 1448 px while
  both are open), `components/rooms/SideChatPanel.tsx` (`thread`, the chip, `withThread`, `onViewThread`),
  `store/sideChats.ts` (`chipOff`), shared `rooms.ts` (`THREAD_LINE`, `threadLineOf`, `nearestThreadOf`,
  `sideQuoteOf` kind `thread`), `lib/sideChatSend.ts`, `chat/Messages.tsx` (the bubble's mark, edit and copy),
  `server/src/chat/prompt.ts` (one line), `title.ts`, `ViewerColumn.tsx` (start rule), `MeetingNotes.tsx` (the card
  12rem up beside a panel), six languages, the guide's page in six languages.
- Differs from the first plan (all from the review, see above): no divider while both are open; 1448 not 1420; a
  thread opened from the room keeps the old rule where three do not fit; a thread line counts once.
- Screenshots looked at for every state at 1440, 1280, 1024 and 390, light and dark (Korean; English at 1440 and
  390): `THREAD_TRINA_SHOTS=<folder> bunx playwright test test/e2e/shots-thread-plus-trina.spec.ts`. New text is
  13 px (the size of the file chips, the quote mark and Send to thread beside it); nothing new has a size of its own.
- PR: (link added when it opens)
