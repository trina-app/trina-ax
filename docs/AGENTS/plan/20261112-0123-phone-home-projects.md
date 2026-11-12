# Phones: Home with the box at the bottom; one bar on a project's screens

- Date (UTC): 2026-11-12 01:23
- Branch: `fix/phone-home-projects`
- Status: done
- Where: web/ (Home, its suggestion blocks, the project pages). Why: the phone app shows the web app, so phone layout
  fixes are web fixes (see docs/REPOSITORY-RULES.md: phones go to the core first).
- Version impact: patch, phone layout only; computers are unchanged.

## Goal

QA rows from the owner's phone audit (11-11):

- TC-253, the owner on Home: "이거 UI가 최적이 맞나?" and "트리나 히스토리가 드로어에서도 보이고 여기서도 보이네." On a
  phone the page was taller than the screen, the box scrolled away under the top bar, the AI history was listed a
  second time under the box, and the suggestions were blocks of rows and text links.
- TC-254, the project screens: three header rows with the name twice, an intro and an orange button on the list, a
  "열기" text link on the files line that jumped to the Files tab, a 32 px "···" on the cards, a resize grip and 12 px
  radios in the new-project sheet.

## Scope

In (phones, below 768 px):

1. Home: the box docked at the bottom above the tab bar, like the ChatGPT and Claude apps; the greeting right above it.
   The one thing at the top (the welcome card, the lead card, the setup row or the goal, the no-AI card) stays at the
   top; the space between them scrolls when it is long, the box never does.
2. Home: no "트리나 기록" list (it is in ☰). `RecentChats` goes.
3. Home: the suggestion block that shows (팀에 준비된 것 or what my group often asks, one at a time as now) is one row of
   chips that scrolls sideways, right above the box; each chip is one 44 px target. 예시 stays its own target. What
   they show and how it is chosen do not change (#428, #430, #431). The add links ("스킬 넣기 · 팀 파일 넣기") become
   chips too, no underlined text links.
4. Projects list: no intro text and orange button in the page; "+" in the top bar (PhoneBarAction) opens the form. The
   card's "···" is a 44 px button.
5. New-project / edit form: no resize grip on the instructions box, the radios are 44 px rows.
6. A project's page: one bar "‹ 프로젝트 · name · ···" (the name in the top bar's title, the name's menu as a MenuButton
   sheet in the action slot); no second row with the name menu, the big name only for screen readers.
7. A project's files: the files line is one row that opens a new screen `/projects/:id/files` inside the 트리나 tab
   (lib/screens.ts parent: the project; a subfolder `?dir=` has the folder above as its parent). Folders go down, files
   open in the file sheet (Back closes it), "파일 탭에서 열기" in the bar goes to the Files tab for uploads and changes.

Out: what the suggestion blocks contain (TC-176 is done in #431), the composer itself (composer agent), the chat row
"···" (TC-248, another session), the tab set (TC-255).

## Steps

1. Plan (this file).
2. Home phone layout (Home.tsx), chips in TeamPrepared.tsx and OftenAsked.tsx; drop RecentChats and its tests.
3. Projects list and form; project page bar; `PhoneBarTitle` beside PhoneBarAction (a tiny touch in PhoneTopBar.tsx).
4. Project files screen: route in App.tsx, lib/screens.ts parent and name, the page in Projects.tsx.
5. e2e `phone-home-projects.spec.ts` following the rows' Steps/Expected; adjust the specs that asserted the old phone
   layout (often-asked, session-markers, phone-nav, member-welcome unit).

## Risks

- Desktop must not change: Home keeps its desktop markup as it is; every change is behind the phone media query or
  `max-md:`. Compare 1440 screenshots.
- The keyboard on iOS: the box docked at the bottom is how the chat screen already works (lib/viewport.ts).
- Other agents' files: PhoneTopBar.tsx (one line for a page title), App.tsx (one route), lib/screens.ts (#468 touches
  another part).
- Five languages for the few new words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, and the
touched e2e specs on port 19355.

## Result

Built as planned, PR #531 (https://github.com/trina-app/trina-ax/pull/531).

- Home on a phone: the box is sticky at the bottom of Home's own scroll area (so it is the same element as on a
  computer, no second composer); the one thing is at the top, the greeting and the suggestion row right above the box.
  `RecentChats` is gone. 1440 screenshots before and after are byte-identical.
- The suggestion row is `components/SuggestionRow.tsx`; TeamPrepared and OftenAsked draw their phone chips with it.
  The phone chips are named by their own text (axe label-content-name-mismatch flagged the shorter aria-label).
- Projects: `PhoneBarTitle` beside `PhoneBarAction` names the bar; `/projects/:id/files` is `ProjectFiles` in
  pages/Projects.tsx, `?dir=` relative to the project's folder; a computer is sent to the folder on the 파일 screen.
- Tests: new `web/test/e2e/phone-home-projects.spec.ts` and `web/test/unit/phone-project-files.test.ts`; adjusted
  often-asked, project-page, project-list-menu, sticky-headers, phone-nav, session-markers specs and the phone-nav,
  member-welcome and team-prepared unit tests.
