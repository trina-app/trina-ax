# A thread and the side chat show together; the side chat's chip names the thread

- Date: 2026-11-17
- Status: accepted
- Supersedes: "one of the two at a time" on the room page in
  [Trina side chat](../DECISIONS.md#trina-side-chat-트리나-사이드-채팅--a-private-side-chat-beside-a-room-feattrina-side-chat-2026-11-09-product-owner)
  and [The room's right column](../DECISIONS.md#the-rooms-right-column--the-files-thread-or-the-trina-side-chat-beside-a-file-in-the-viewer-featroom-viewer-column-2026-11-09-product-owner)
  (the file viewer's column keeps it); adds a width to the list's folding rule of the nav rail
  (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1). The rest of both stands.
- Branch: feat/thread-plus-trina (the owner; plan docs/AGENTS/plan/20261117-0608-thread-plus-trina.md)

- **Ask:** with a thread open in a conversation, opening the ✦ side chat closed the thread, so a person could not read
  the thread while asking the AI about it. The owner wants them side by side, the way Slack shows a thread and its AI
  panel, and a small removable chip in the AI's box saying it is looking at that thread. The idea, not Slack's words or
  layout.
- **Why it was one at a time:** one slot. `pages/Room.tsx` drew the thread or the side chat, an effect closed the side
  chat when a thread opened, and ✦ closed the thread first.

- **Rule: the layout, by the width of the page's own row** (`web/src/lib/roomColumns.ts`; the row is the window less
  the rail, the conversation list when it shows and a file preview panel):

  | Row | What shows |
  |---|---|
  | 1060 px or more | room, thread, side chat: three columns. The room keeps 420 px; the two panels share the rest evenly, 320 to 440 px each |
  | 640 to 1059 | thread and side chat, half and half; the room waits under them (kept as it is, out of reach, not marked read) |
  | under 640 | one panel at a time: the side chat over the thread; its ✕ or ‹ goes back to the thread |

  One panel alone is as before (a column with its divider and remembered width; a sheet at 768 to 811 px; the whole
  screen on a phone).
- **What gives when three do not fit, in order:** (1) the conversation list folds away while both are open and the
  window is under 1448 px (`rail/railPanel.ts PANEL_ALWAYS_BOTH_PX`: the rail at its widest, 88, the list at its
  widest, 300, and 1060), as it already folds below 1052 px beside one panel; so whenever the list shows, three columns
  fit, and at 1440 the three get air (568, 400, 400) instead of all sitting at their minimums. (2) Then the room gives
  way to "thread, side chat". (3) Then one panel at a time. **Why:** the person opened ✦ on a thread to read the two
  together; what they are not reading goes first. Not taken: the side chat as a sheet over the thread (the problem
  itself), three columns under their minimums, folding the list at every width.
- **Which way they come together.** The room gives way only when the person asked for the side chat on a thread (✦,
  the ask hint, "Ask ✦ about this", the file preview's ask, a window made smaller). A thread opened **from the room**
  while the side chat is open keeps the old rule where three would not fit even with the list folded: the thread takes
  the side chat's place (a click in the room must not make the room disappear) and ✦ brings the same chat back beside
  it. A thread in place of another keeps what shows.
- **The first frame is the right layout.** The page reads its own row as it draws and adds the list's width while
  the list still shows in a window where it folds for the two (`Room.tsx rowForBoth`): the render in which the second
  panel opens comes before the list is gone. Without it, at 1280 the two were drawn over the room for one frame and
  the keyboard jumped into the side chat (found in the code review).
- **"View" under a sent answer** opens the thread through the room page (`threadOpening`: in place of an open thread,
  so the thread's ✕ steps back to the room once). Where the side chat would hide that thread, it steps aside as a
  hand-off (✦ brings the same chat back).
- **A file preview beside the page** takes its width first, as beside a thread (the page keeps 740 px), so with both
  panels open the page shows "thread, side chat"; in a small window it drops to one at a time.
- **No divider while both are open.** A divider on the thread alone would save its width as a share of a smaller row
  and change a single panel's width later; two dividers are more than this needs. The remembered width is a single
  panel's and applies again when one closes.

- **Rule: the chip.** While a thread is open on the room page, the side chat's box shows **Looking at this thread**
  with ✕ (label: "Ask about the whole conversation instead"). With it on:
  - a question is sent with a **thread line** on top: `> 🧵 <who started it> · <when> (thread_id <id> in this room)`,
    an empty line, the question (shared `rooms.ts THREAD_LINE`, `threadLineOf`; web `SideChatPanel withThread`). It is
    a quoted message's header with no message under it: the app sends the thread's id only;
  - **the server decides what is read**: the AI reads the thread with `room_read`, which checks on every call that the
    person is in the room now and may see that thread. An id typed by hand reads nothing they cannot see. No new
    field, endpoint or migration; `looking_at` is unchanged;
  - the side panel's instructions gain one line (`prompt.ts sideRoomSection`): such a first line means that thread,
    read it first; a question without it is about the room;
  - the bubble shows "Thread · who · when" (never the line or the id); copy and edit show the question without the
    line, and saving an edit keeps it (`lib/sideChatSend.ts shownQuestion`, `keepThreadRef`; in a side chat only: a
    line of that shape typed by hand in another chat is text like any other);
  - the answer offers **Send to thread** for that thread, and `post_to_room` goes there;
  - an empty chat offers one starter, **Summarize this thread**, and the "Looking at <room> with you" line is not drawn
    (one line says what is looked at).
- **✕** takes the chip off for the open thread (`store/sideChats.ts chipOff`): questions go as typed, about the room.
  It is back when the thread is closed and opened again, another opens, or the side chat is closed and opened. A message quoted with "Ask ✦ about this"
  takes the chip's place while its card shows. No chip for a guest whose AI cannot read the room.
- **A thread line counts for its own question only** (`nearestThreadOf`, web `sendTargets`): a quoted message's thread
  still carries on to follow-ups without a quote, but the chip puts its line on every question while it is on, so a
  question without the line was asked with the chip off and its answer goes to the room. That makes "chip off = the
  room" true for where answers go.
- **This is not "the screen in every turn"** ([20261116-ai-screen-and-shared-tools.md](20261116-ai-screen-and-shared-tools.md)):
  the line is part of the person's own question, they see it and can take it off; nothing rides on a turn by itself.

- **Keyboard.** Beside the room (columns) Esc closes nothing, as before. Where panels cover the room (the pair, a
  sheet) Esc closes one a press: the one the keyboard is in, else the side chat, then the thread; never while a menu
  or dialog of its own is open, never while an input method composes (Esc there cancels the composition), and after a
  file preview beside the page (the app frame's Esc closes that first). The pair is two labelled regions over an inert
  room, not two modal dialogs. Tab order is room, thread, side chat.
- **Marked read.** A room under panels and a thread under the side chat are out of sight: nothing in them is marked
  read until they show again. (The room under a sheet at 768 to 811 px was marked read before: wrong for the same
  reason, fixed with it.)
- **What is remembered.** Nothing new: the thread is the address; the side chat is open while the page stays in the
  room and closes when it leaves; the chip's ✕ lasts while that thread and the side chat stay open; the single panel's width as before.
- **The file viewer** keeps one thing at a time in its column. It starts on the side chat only when the room page
  shows the side chat without a thread, so a picture opened from the thread beside it starts on its thread.
- **Meeting-notes card** (desktop app): fixed to the window's bottom right, it sat on the message box of a thread or
  side chat. With a panel on a conversation's right it now sits above that box (12rem up).
- **On the server, accepted as it is:** a side chat already counts as having read rooms, so no card gets looser; a
  chip question about a thread an app's card started marks the chat as holding outside words, as quoting that card
  does (`quotesAppOnBranch`); the line is not the person's "own words" for the web address gate and the explicit-ask
  rules (`isQuoteLine`), as a quote is not.

- **Left out (lean):** a second divider; tabs or a swap of columns; a button to put the chip back; any new setting or
  stored state; reopening the side chat after a reload; a thread picker; the chip in a full chat or in the file
  viewer; a ✦ button in a phone's thread header (a phone opens the side chat on a thread with "Ask ✦ about this": the
  first question carries the quoted message, the chip shows for the next).
- **Tests:** `web/test/unit/room-columns.test.ts`, `side-chat.test.tsx` (both show, the chip, what a send carries, ✕,
  the thread closing), `side-chat-send.test.tsx` (the line, its own question only, copy and edit),
  `rail-badges.test.tsx` (the list's state with both open); `tests/unit/b-post-to-room.test.ts` (the prompt line),
  `b-chat-titles.test.ts` (the title); e2e `web/test/e2e/thread-plus-trina.spec.ts` (three columns at 1440 and 1280,
  the pair at 1024 with Esc, a phone's way back, "View" with the thread open) and `shots-thread-plus-trina.spec.ts`
  (every state at 1440, 1280, 1024 and 390, light and dark, font sizes).
- **Version impact:** minor (a visible change of the room page; no API, data or permission change).
