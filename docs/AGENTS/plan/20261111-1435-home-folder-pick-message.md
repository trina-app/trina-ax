# Desktop app: picking the home folder says it can't be used

- Date (UTC): 2026-11-11 14:35
- Branch: `fix/home-folder-pick-message`
- Status: done
- Where: `desktop/src` (core desktop app). Why: the refusal happens in the desktop app's folder rules (see docs/REPOSITORY-RULES.md)
- Version impact: patch: the desktop app explains a refusal it already makes; no rule changes

## Goal

QA TC-219 (P2). In the desktop app, a team page step that picks a folder (company documents in Getting started, the
skills import) opens the macOS / Windows folder window. When the person picks their home folder, the app refuses it
(`file-system-access-restricted` → 'deny', on purpose: home holds other apps' sign-ins), and the page gets an
AbortError, the same as Cancel. Nothing is shown; the person does not know why nothing happened.

After this change the app says so in its own language and offers to pick another folder: "홈 폴더는 통째로 고를 수
없어요 · 그 안의 폴더(예: 문서, 다운로드)를 골라 주세요" with **다른 폴더 고르기** (the folder window opens again,
Electron's 'tryAgain') and **취소** (the page gets its AbortError as before). Other folders Chromium blocks (~/Library,
/, system folders) get "이 폴더는 고를 수 없어요 · 시스템 파일이 들어 있는 폴더예요".

## Options

1. A message box in the desktop app with "pick another folder" (chosen): the app is the one that refuses and knows why;
   the page cannot tell a refusal from a cancel (both AbortError). No bridge change, no web change.
2. Tell the page over the bridge and let the page show it: needs a new bridge event and matching it to the AbortError;
   more moving parts for the same words.

## Scope

In: `refusedFolderReason()` (pure, folder-access.ts): 'home' (home or a folder holding it), 'blocked' (anything else
refused), or null (not the team page's own pick: still silent). `hardenAppSession` asks the window for a decision on
'home' / 'blocked'; app-window.ts shows the box. Strings in five languages (desktop i18n).
Out: what may be picked does not change. Chrome on the web shows Chrome's own message already.

## Steps

1. folder-access.ts: `refusedFolderReason`; unit tests in tests/unit/e-desktop-folder-window.test.ts.
2. security.ts: on 'deny', a reason → `refused(reason)` → 'tryAgain' | 'deny'; the callback is always called once.
3. app-window.ts: the message box on the team window; strings in desktop/src/common/i18n.ts.

## Risks

The callback must always be called (the page's pick waits for it): any failure answers 'deny'. A message only for the
team page's top frame at an allowed origin, so another page cannot raise app dialogs. Five languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/e-desktop-folder-window.test.ts
tests/unit/e-desktop-common.test.ts`.

## Result

As planned. `refusedFolderReason` (pure) in desktop/src/common/folder-access.ts; `hardenAppSession(ses, origins,
refused)` asks the team window on a refusal of the page's own pick; `AppWindow.folderRefused` shows the box (five
languages in desktop/src/common/i18n.ts) and answers `tryAgain` or `deny`. Unit tests for the reasons and the wiring;
the real-Electron folder spec now records what would be said: home → "home", app data → "blocked", another origin's
refusal → nothing. The macOS folder panel and the box itself were not clicked (no person in the headless run).
