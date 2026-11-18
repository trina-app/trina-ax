# Phone Chats tab: the list no longer drags sideways

- Date (UTC): 2026-11-18 01:56
- Branch: `fix/chats-tab-sideways`
- Status: in progress
- Where: web/ (the team web app, shown by the phone app's WebView). Why: the overflow is in the web page at phone width
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a layout bug fix

## Goal

QA TC-4833: in the phone app, the Chats tab alone can be dragged sideways; while scrolling the list up and down the page
also moves a little horizontally. The other tabs do not. After this, the Chats list only scrolls up and down.

## Cause (measured)

At 360, 390 and 430 px the Chats list (`rooms-page`, `overflow-y: auto`, so its `overflow-x` computes to `auto` too) is 2 px
wider than the screen (scrollWidth 392 for clientWidth 390). The element: the section header's ⊕ (Channels, Direct
messages; `SectionAddButton`, 24 px with `touch-hit`). On phones `touch-hit` gives it a 44 px tap box (`::after`, centred),
which reaches 10 px past the button's right edge, while the header's right padding on this page is 8 px (`pr-2`). The
2 px past the list's edge make it a sideways scroller. It does not depend on names or counts: rows truncate. Other tabs
have no such control at their edge.

## Scope

In: the Chats tab's section header padding on phones, so the ⊕'s tap box ends at the list's edge; an e2e guard
(Chromium and WebKit) that every phone tab is no wider than the screen and that a swipe on the Chats list leaves it at
scrollLeft 0.
Out: no global `overflow-x: hidden`, no `touch-action`/`overscroll-behavior` change (with no overflow there is nothing
to pan; `touch-action: pan-y` would also stop pinch zoom).

## Steps

1. Header right padding on phones 8 → 10 px (`pr-2.5`), so the 44 px tap box ends exactly at the edge.
2. Guard in `web/test/e2e/phone-chats-tab.cases.ts` (runs in both engines).
3. Measure on a local copy of the QA team at 360/390/430, light and dark, all tabs, Chromium and WebKit.

## Decisions

None.

## Risks

The ⊕ moves 2 px left on phones. Computers are unchanged (`sm:pr-4`, and `touch-hit` is phone-only).

## Tests

`bun run typecheck`, the phone Chats tab e2e in Chromium and WebKit.

## Result

To be filled in.
