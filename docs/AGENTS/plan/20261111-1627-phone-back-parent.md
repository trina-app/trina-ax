# Phones: Back goes to the screen's parent; tab taps don't pile up history

- Date (UTC): 2026-11-11 16:27
- Branch: `fix/phone-back-parent` (stacked on #344, `batch/phone-settings`)
- Status: in progress
- Where: Team AX core, `web/` (`lib/screens.ts`, `lib/screenHistory.ts`, the tab bar and the phone bars). Why: the
  phone app is the web app in a WebView, so its Back is the web app's history (see docs/REPOSITORY-RULES.md).
- Version impact: minor (phone navigation behaves differently; no API change)

## Goal

QA TC-244 (P1). The owner: "뒤로가기가 그냥 쌓이는 듯. 다른 폴더 갔다가 뒤로 가기 하면 이전 폴더로 감. 이게 맞는 방향인가?"
The iOS edge swipe (`allowsBackForwardNavigationGestures`) and Android Back (`webView.goBack`) walk the browser
history, which today is a log of visits: every folder and breadcrumb is a push (FILES-01), Team folder ↔ Trash pushes
(FILES-14), tab taps are plain links (FILES-13, CHATS-06, SET-02, TRINA-21), a chat's project link ping-pongs with the
chat (TRINA-13), 나 › 연결한 서비스 jumps to the 트리나 tab (SET-04), some ‹ have no label (SET-25), and the folder access
link to Admin does not come back to the folder (FILES-15). On phones (below 768 px) the history becomes the screen
hierarchy of the tab on screen. Computers and tablets are unchanged.

## Scope

In:
- `lib/screens.ts`: one route table. For an address: its home tab, its parent address, its identity (what makes two
  addresses the same screen: Files' `path` and `view`, not `select`/`access`/`history`), sideways params (Files'
  `view`), whether it is a folder tree (Files), and its name for a ‹ label.
- `lib/screenHistory.ts`: the router's history (React Router `unstable_HistoryRouter`), the browser history as React
  Router writes it on computers. On phones every entry also keeps `scr: { tab, sid, trail }` in its history state (the
  stack's tab, the stack's id and the addresses from the tab's root to it), so a reload or a WebView restore keeps it.
  - down = push; to a screen already in the stack (an ancestor, the chat a project was opened from) = `history.go(-n)`
    back to it (then a replace when its address differs, e.g. `&access=1`); to the same screen = replace; sideways
    (only sideways params differ) = replace.
  - Files folders are a tree: a push to a folder goes back to the deepest folder of the stack above it and pushes the
    folders in between, so Back is always the parent folder; up to a folder not in the stack = replace.
  - a tab tap never adds entries: another tab = switch stacks (go back to the stack's first entry, replace it with the
    other tab's saved stack and push the rest, with their keys, as one change the router sees); the tab on screen =
    back to its root. Each tab's root is the first entry, so Back at a root never walks into another tab. Forward
    entries left from the stack before are skipped.
  - opened from outside (the document's first entry, shown for the first time, once the signed-in app shows it): the
    parent chain is put under it.
  - the tab bar marks the stack's tab, so a page pushed from 나 (연결한 서비스) keeps 나 marked.
- ‹ labels from the stack (the entry under this one) with one namer for every screen (PhoneTopBar pages, Admin,
  Settings); ‹ at a stack's root goes to the screen's parent in place of the entry.
- Call sites: Files' Team folder/Trash switch (replace), Connectors' detail ‹ (back, not a push), Admin › Folder
  permissions opened from a folder or a project comes back there (no Admin list put between).
- Phone e2e for each case in the QA row; unit tests for the table and the history rules.

Out: overlays, sheets, Modal, MenuButton, Search Back (overlay-back), the native app bridge (push notifications opening
a tab), Files layout, Admin in-page views getting addresses.

## Contract with overlay entries (lib/backCloses.ts, lib/imageViewer.ts)

- An overlay entry is a browser entry pushed while something is open, at the same address, with React Router's state
  copied (`idx`, `key`, `usr`, and `scr`) plus a field whose name starts with `__` (`__backCloses`, `__imageViewer`,
  `__viewerSheet`). The screen history never makes, rewrites or counts them; a pop onto or off one reaches the router
  as the same screen, as before.
- On a phone, a router push made while an overlay entry is on top takes that entry's place (replaceState) instead of
  pushing above it, so no overlay entry is left under a page. The overlay then finds its entry gone and has nothing to
  go back over.
- Rewrites (tab switch, back to an ancestor, back to a tab's root) go back past overlay entries on top; each overlay's
  own popstate listener closes it, as for a Back.

## Steps

1. `lib/screens.ts` + unit tests.
2. `lib/screenHistory.ts` + unit tests (a fake window history).
3. Wire: `App.tsx` router, `BottomTabs.tsx` (switch, mark), `PhoneTopBar.tsx` (label, parent fallback),
   `lib/backStack.ts` (labels from the stack), `lib/back.ts` (parent fallback), `Layout.tsx` (first entry's parents),
   `lib/tabs.ts` (titles from the table).
4. Call sites: Files (Trash switch), Connectors `onBack`, AdminLayout `inside` for Folder permissions.
5. `web/test/e2e/phone-back-parent.spec.ts` (WebKit, 390×844, touch); run #344's phone-admin, phone-nav and back-stack.

## Risks

- WebKit limits `pushState` (100 per 30 s): a restored stack is capped at 12 entries; a failure keeps what was made.
- Async rewrites (`history.go(-n)` then replace/push): navigations made meanwhile wait in a queue; a popstate that
  never comes ends the wait after 600 ms.
- #344's Admin/Settings list-under-page stays (its hook now goes through this history); its tests must pass.
- One-line import overlap with #430 in `App.tsx`.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`; the new phone
spec plus `phone-nav`, `phone-admin`, `phone-list-pages` on port 19351.

## Result

(filled in at the end)
