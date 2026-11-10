# Copying room messages gives the messages, not the buttons

- Date (UTC): 2026-11-10 08:09
- Branch: `fix/clean-message-copy`
- Status: done
- Where: trina-ax/web (room message list, chat message action rows). Why: room and chat screens are core UI (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a copy fix with no API or data change

## Goal

Selecting several messages in a room and pressing ⌘C pastes the hover bar's quick reactions (✅ 👀 👍) of every
message, the author and time on separate lines and many blank lines. The hover bar is in the page for every message
(only its opacity hides it), so the browser copies it. A copy should give the messages and nothing else.

## Scope

In:
- Nothing in a room message that is not its words can be selected or copied: the hover bar, reaction chips, the
  "N replies" thread line, the "edited" mark, file chips' buttons, the quote and "asked by" lines. The message row is
  `select-none`; its words (the text, an AI answer's Markdown, a shared answer, the deleted and hidden placeholders) are
  `select-text` (still none on touch screens, where a long press opens the menu).
- A `copy` handler on the message list: a selection over more than one message (or over a run's name and time) is
  copied as plain text, one message per block: "Name  2:57 PM", then the text, a file as its name, one blank line
  between messages; one author line for a run of one author; a date line when the selection crosses a day; an event
  line as its own line. A partial first or last message gives its selected part. No `text/html`.
- A selection inside one message is left to the browser, as today (now without the hidden controls).
- The thread panel uses the same list. The side chat uses the AI chat's messages: their action rows (copy, send here,
  regenerate, model name, branch switch) become `select-none`; the copy buttons stay.
- CHANGELOG line, DECISIONS entry.

Out: rich (HTML) copies of several messages; the AI chat's own multi-message copy format.

## Steps

1. Plan (this file).
2. `lib/messageCopy.ts`: the pure builder (`copyPlainText`) and the DOM reader (`selectionItems`).
3. RoomMessages: row `select-none`, words `select-text`, `onCopy` on the list. chat/Messages and SendHere: action rows
   `select-none`; Markdown's own copy bars `select-none`.
4. Unit tests for the builder; e2e: three messages copied clean, one message unchanged, a thread, the side chat.

## Risks

No migration, no API. Phones: the row stays unselectable on touch screens as before. The status emoji of the custom
status PR (#288) sits in the run header; the builder reads only the name and time, so it is never copied.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the room,
thread and side-chat e2e specs plus a new `room-copy.spec.ts`.

## Result

Built as planned. The copy handler reads the page (rows, their `select-text` words, the run's name and `<time>`), so the
timeline and a thread's two lists copy the same way; the parts are read with one off-screen layout (innerText keeps the
line breaks). Added after the review: Firefox's selection of several ranges is read as one; a hidden ("withheld") row
and the run's avatar cannot be selected; a clone drops pictures and diagrams. Also unselectable now: the AI chat's steps
toggle. Unit tests (web) 2081 pass, 0 fail; e2e room, thread, side-chat and chat specs 178 pass (22 screenshot tests
skipped), the new `room-copy.spec.ts` 8 pass. PR: #316.
