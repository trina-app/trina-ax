# Phones: the keyboard keeps the newest message in sight, and sheets stay above it

- Date (UTC): 2026-11-10 13:47
- Branch: `fix/phone-keyboard-keeps-bottom`
- Status: in progress
- Where: trina-ax core, the web app (`web/src/lib/stickToBottom.ts`, `web/src/lib/viewport.ts`, the four message lists,
  `components/ui.tsx` Modal, `components/rooms/MenuButton.tsx`, `components/StatusMessage.tsx`), its unit and e2e tests,
  docs/DECISIONS.md, `changes/`. Why: chat, rooms and the phone layout are core (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Web app only; no API, data or phone app change (works in store builds as they are).

## Goal

Three phone keyboard bugs the owner found:

1. At the bottom of a conversation, tapping the message box opens the keyboard but the list keeps its scroll position:
   the newest messages go behind the box. Expected: at the bottom, the newest message stays right above the box;
   scrolled up, the message being read stays where it is. Same when the keyboard closes.
2. With the keyboard open, a long press on a message opens its sheet (reactions on top) under the keyboard, and the
   keyboard stays. Expected: the keyboard closes, the sheet is in sight; the draft stays, the keyboard does not come
   back by itself.
3. "Set your status" opens as a sheet and focuses its box at once; the keyboard covers the suggestions, the "Clears"
   chips and Cancel / Save. Expected: every sheet with a text field stays above the keyboard with its buttons in sight;
   the status box takes the keyboard only when tapped.

Cause of 1, measured in the iOS 26.5 simulator with a bare WKWebView host like the phone app's (Safari did not show
it): opening the keyboard shrinks the list (629 → 248 px) and, in the same frame, the engine moves its scrollTop up
22 px. That scroll event comes before the ResizeObserver; `followsAfterScroll` reads the move up as the reader leaving
the bottom, so the observer that runs next no longer follows.

Cause of 2 and 3: a sheet is `position: fixed` against the layout viewport, which iOS Safari does not shrink for the
keyboard (the page itself follows `visualViewport` through `--app-h`). A long press opens the sheet without moving the
focus, so the keyboard stays.

## Scope

In:
- One hook for the four lists (room timeline with DMs and group chats, thread, side chat, AI chat): at the bottom when
  the list's size changes, it stays at the bottom; not at the bottom, the first visible message keeps its place. A
  scroll event in the same frame as the list's own size change is the browser's, not the reader's. It also listens to
  `visualViewport`.
- `lib/viewport.ts` also sets `--kb-inset` (the part of the layout viewport under the keyboard). Phone sheets (Modal,
  the message menu sheet) end there and are at most `--app-h` high; their body scrolls, header and footer stay.
- Opening a message's sheet on a phone (long press, ⋯) first takes the focus off a text field so the keyboard closes.
  A sheet that closes does not put the focus back into a text field on a touch screen.
- The status dialog does not focus its box on touch screens. Other sheets: checked, listed in the PR.

Out: the phone app's native code (not needed: the WKWebView already shrinks its viewport; Android lifts the WebView).

## Steps

1. Hook + pure helpers in `lib/stickToBottom.ts`; unit tests (at the bottom after a shrink, an engine nudge in the same
   frame, scrolled up: the anchor keeps its offset, keyboard closing).
2. Room, DMs/groups, thread, side chat, AI chat use the hook.
3. `--kb-inset`, Modal and MenuButton sheets, blur on opening a message sheet, no refocus of a text field on touch.
4. Status dialog autofocus on touch; check other sheets.
5. e2e at 390 px (`phone-keyboard.spec.ts`): room, AI chat, side chat at the bottom and scrolled up with a shrunk
   viewport and a mocked `visualViewport`; long press with the keyboard up; status sheet and emoji search.
6. Screenshots, DECISIONS, changes/ note, review, PR to dev.

## Risks

Computers: the hook keeps the old behaviour (a window resize at the bottom stays at the bottom, else the browser's
own scroll position). Sheets change only below their phone breakpoints. No migration, no permission change, no new
text (no i18n change).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the new spec
and the room, chat, side-chat, thread, reaction picker and phone-nav specs.

## Result

Filled in at the end.
