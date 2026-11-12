# Phones: Back closes the open sheet, menu or dialog first

- Date (UTC): 2026-11-11 16:25
- Branch: `fix/phone-back-closes-overlays` (stacked on `batch/phone-settings`, #344)
- Status: done
- Where: trina-ax/web. Why: the phone app is one WebView of the web app, and Back there walks the web app's history.
- Version impact: patch. A fix to how Back behaves on phones; nothing new to learn, computers unchanged.

## Goal

QA TC-245 (P1). On a phone (the app's WebView, a phone browser) the iOS edge swipe and Android's Back walk the
browser history. Sheets (`rooms/MenuButton.tsx`) and dialogs (`ui.tsx` `Modal`, 64 uses) hold no history entry, so
Back leaves the page under them: a room's message sheet, 🔔, ⋯, members and the @ list (CHATS-04); Files' Move and
Version history (FILES-12); search from the drawer, where Back 1 closes the hidden drawer and Back 2 goes to another
page with search still open (TRINA-20); the side chat's 🕘 list, where Back closes the whole side chat (CHATS-22); the
Chats new-chat picker, opened with `replace` (CHATS-05). After this, Back closes only the top layer and the page stays.

## Scope

In:
- One mechanism, `lib/backCloses.ts` `useOverlayEntry(open, close)` (+ `holdOverlayEntry` for code outside React),
  merging the old `holdBackEntry`/`useBackCloses` and the history half of `lib/imageViewer.ts`. Phones only (below
  768 px): a computer's dialog gains no history entry.
- Called once in `Modal` and `MenuButton` (covers all their uses, and the menus the menus-tabs agent turns into
  MenuButton sheets), and in `SearchDialog`, the drawer, the side panel, the side chat, the image viewer and its sheet,
  the side chat 🕘 list, the @ list and the Chats new-chat picker.
- Search from the drawer closes the drawer; search takes over its entry.
- The new-chat picker: `?new=1` is a request that opens it (the top bar's ⊕, links) and leaves the address; the picker
  then holds an overlay entry like every dialog.

Out: route parents, per-tab stacks and tab taps (nav-model, TC-244); admin in-page detail views; `pages/FileView.tsx`
(TC-228 is being fixed there).

## How it works (the contract)

- An overlay entry is a history entry at the same address as the page under it, with the page's state copied (React
  Router's `idx`, `key`, `usr`) plus `mycelOverlay: <id>` and `mycelOverlayDepth: <n>` (1 for the first overlay over a
  page). `isOverlayEntry(state)` is exported. **The nav wrapper leaves entries with `mycelOverlay` alone**: it does not
  count them as pages and does not rewrite them.
- Open: one `pushState` on top. Back (a popstate that lands below an overlay's entry) closes every overlay above the
  landed entry, top first, one per entry: nested overlays unwind one at a time.
- Close any other way (✕, scrim, Esc, a choice): its entry is backed off after the moment's effects (a microtask),
  with one `history.go(-n)` for all closed at once. An overlay that opens in the same moment (a menu item
  that opens a dialog) takes over the closing entry with `replaceState` instead: no back, no push, no race.
- An overlay opened while a back of ours is on its way pushes its entry once the back has landed.
- Navigating from inside an overlay: `history.pushState` is wrapped once; a push (the router's) while an overlay entry
  is on top **replaces** that entry, so no stale entry is left under the new page. A replace while an overlay entry
  is on top (a filter in the address) gives the page entry the new address and holds the overlay's entry again on top.
- Entries left behind (a lower overlay under a page pushed from the top one) and entries backed off (ahead as Forward
  entries) are skipped: Back over a left-behind one goes on back; Forward onto either goes on (or back where it was).

## Steps

1. Rewrite `lib/backCloses.ts` as the overlay stack; unit tests with a fake history.
2. Image viewer: viewer and its sheet use `holdOverlayEntry`; `closeImageViewer(back, then)` keeps `then`.
3. Hook calls: `Modal`, `MenuButton`, `SearchDialog`, `Layout` (drawer, panel), `Room` (side chat), `SideChatPanel`
   (🕘 list), `useMentionMenu` (@ list), `Rooms` (picker); `Sidebar` search closes the drawer.
4. Phone e2e (Chromium + WebKit, 390×844, touch): every case in TC-245's steps, dialog → confirm nesting, a menu item
   that opens a page, ✕ leaves no entry; desktop: a dialog adds no entry.

## Risks

- Every dialog and menu on phones now pushes an entry: a wrong count would make Back do nothing or skip a page. Unit
  tests cover the stack; e2e count Backs.
- Other agents: nav-model wraps the router's history at the same time (contract above); menus-tabs moves menus to
  MenuButton (covered by the hook, props unchanged); composer edits `SideChatPanel.tsx`'s composer (the 🕘 hook is
  elsewhere in the file). PR #430 touches `Room.tsx` near the side chat line.
- No migration, no server change, no new words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, the new unit
test, and the new and touched phone e2e specs on port 19352.

## Result

Built as planned, in `web/src/lib/backCloses.ts` (`useOverlayEntry`, `holdOverlayEntry`, `isOverlayEntry`,
`whenOverlaysSettled`); `lib/imageViewer.ts` keeps only its state and uses it. Also hooked: `TitleMenu` (the chat title
⌄) and `PhoneFilters` (Activity log's Filters). Found while building: in Chromium and WebKit a push made while a back is
on its way is lost, and WebKit merges two back() calls in a row into one, hence the one `go(-n)`, the hand-over in the
same moment and the push again after landing. The Files row ⋯ and Search's row ⋯ are not MenuButtons yet (files and
menus-tabs agents): they get Back when they are. PR: https://github.com/trina-app/trina-ax/pull/452

Review fixes (on dev, with #457): one history traversal at a time. `history.go`/`back`/`forward` are wrapped, and
another's traversal counts as on its way until its popstate. The phone screen history's steps arrive as the window
event `mycel:history-steps` (#457's `lib/historySteps.ts`). No back-off of ours starts during either. The app's step
back from inside an overlay (the room's ‹ with the @ list open) goes past the overlays' entries, so one tap leaves the
page. A push made during our back is pushed again only when the browser dropped it.
