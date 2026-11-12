# Phones: a 프로젝트 tab in place of 파일 (QA TC-255, option D)

- Date (UTC): 2026-11-12 09:14
- Branch: `feat/phone-projects-tab`
- Status: done
- Where: trina-ax (`web/`). Why: the phone app is the web app in a web view, the tabs are the web app's, and the core
  repo is frozen, so this Trina-only change goes here with no edition flag (see docs/REPOSITORY-RULES.md)
- Version impact: minor (a visible change to the phone app's tabs; no API or data change)

## Goal

The owner (iPhone QA, 11-11): "파일들보다 프로젝트 탭을 볼 일이 더 많지 않을까?". Decision after the review (option D):
phone tabs **트리나 · 대화 · 프로젝트 · 나**. Projects in 1 tap, a project's chat in 2, the team folder through
프로젝트 › 팀 폴더. Computers (768 px and up) are unchanged.

## Scope

In:
- `lib/tabs.ts`: tab `projects` replaces `files`; its root is `/projects`. `/projects…`, `/?project=` and `/files…` (Files
  and its Trash, `?view=trash`) belong to it. `/trash` (deleted AI chats) stays 트리나's.
- `lib/screens.ts`: `/projects` is a root (no parent); `/files` is under `/projects`; a folder under its folder, a file
  under its folder, the Files trash under `/files`, as today. `/c/:id` opened from outside is always under `/` (트리나):
  never looked up in the chat list, which may not have loaded yet. A chat opened inside the app stays on the stack it was
  opened from (a project's page: Back returns to the project).
- New saved-stack key (`mycel.tabStacks.v2`), so stacks saved under the old `files` tab are not put back.
- 트리나's tab icon: Trina's star (`TrinaStar`, `mono` in the tab colours) where the product is named after its AI (the
  owner, 2026-11-12: "모바일에서는 트리나 아이콘이 달라서 좀 헷갈리는듯"); the sparkle in the core edition.
- `BottomTabs.tsx`: the 프로젝트 tab (`tab-projects`, FolderKanban), labels on one line (`whitespace-nowrap`, truncated).
- `pages/Projects.tsx` (phone only): a fixed "팀 폴더" row at the end of the list that opens `/files`; the empty state
  says what a project is, offers 새 프로젝트, and keeps the 팀 폴더 row below.
- `PhoneTopBar.tsx`: no ‹ at a tab's root (`/projects`); Files keeps its own bar.
- `pages/Files.tsx` (navigation only): at the team folder, "‹ 프로젝트" (Back in the stack, else to `/projects`).
- A chat's new-chat button and Delete: on a phone, switch to 트리나 and show Home (no Home pushed on the 프로젝트 stack).
- `components/Sidebar.tsx`: 프로젝트 leaves the phone's ☰ drawer; the computer's sidebar keeps it.
- i18n: `tabs.projects` and the empty-state line in en, ko, id, ja, es; `tabs.files` goes.
- Docs: `changes/phone-projects-tab.md`, `docs/DESIGN-SYSTEM.md` phone line. No `docs/DECISIONS.md` edit (the decision
  text goes in the PR body).

Out: the computer's sidebar and routes, Files' layout and rows, the mobile app (no change needed: nav-v1 already asks
the page where Back goes).

## Steps

1. Plan (this file).
2. tabs/screens/screenHistory/appNav + unit tests.
3. BottomTabs, PhoneTopBar, Sidebar drawer, Files ‹, chat new/delete.
4. Projects phone list: 팀 폴더 row and empty state; i18n.
5. Update the phone specs that use `tab-files`; new `phone-projects-tab.spec.ts` (Chromium and WebKit); text-size with
   Japanese and Spanish at 140 % and 360 px.
6. 1440 screenshots before and after; checks; PR.

## Risks

- Per-tab stacks: an old saved stack under `files` would come back under the wrong tab: new storage key.
- Android Back (nav-v1): a tab root other than 트리나 → 트리나 → leave the app; `/projects` is now such a root.
- Notifications: a `/files?path=` notification is a page load (not an id path), so it is "opened from outside" and gets
  `/projects` › `/files` › folders under it.
- No migration. Five languages; the longest labels ("Proyectos", "プロジェクト") at 360 px and 140 % text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web` once; the unit
tests for screens, phone-nav and app-nav; the phone specs touched and the new spec on MOCK_PORT 4578.

## Result

Built as planned, in PR #596. Differences and additions:
- The team folder's phone bar is titled **팀 폴더** (`files.root`), the name of its row on the list, with "‹ 프로젝트".
- The empty state reuses `projects.empty` and `projects.desc`; the only new key is `tabs.projects` (`tabs.files` went).
- `/c/:id`'s parent is always `/`: the chat list is no longer read for it (it decided the tab by whether it had loaded).
- `knownTab`: a history entry kept from the old build (`scr.tab: 'files'`) takes its first entry's tab.
- Found on the way: after `settleOpened` put parents under a page opened from outside, the phone app was not told where
  Back goes (nav-v1 kept `canGoBack: false`); `historySettled()` (lib/historySteps.ts) tells it now.
- Tests: unit (screens, phone-nav, phone-project-files, app-nav, lib), the new `phone-projects-tab` spec in Chromium and
  WebKit, the phone specs that used `tab-files`, `text-size` with ja and es at 140 % and 360 px.
