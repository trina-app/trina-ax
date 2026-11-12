# Phones: Home with the greeting in the middle and one composer card above the tab bar

- Date (UTC): 2026-11-12 09:16
- Branch: `feat/phone-home-centered`
- Status: in progress
- Where: trina-ax `web/` (common code). Why: the phone layout of Home and its message box is shared by every team, not
  Trina's sales or operations.
- Version impact: patch. A phone layout change of one screen, no API or data change.

## Goal

QA row TC-391. The owner looked at the iPhone Home ("메인 화면이 이게 맞아?"): the greeting and the box sit low, under
a big empty area, and a separate "Default AI ⌄" line sits under the box. He wants the layout of an AI app: the mark and
the greeting in the middle of the free space, and one composer card above the tab bar with the text on top and a row
under it (+ · the engine picker · mic · send). One hard rule: no keyboard by itself ("채팅이 보고싶은 걸 수도 있는데"),
so the tab bar stays until the person taps the box.

## Scope

In:
- `pages/Home.tsx` (phones only): the Trina mark (`TrinaStar` where the product is named after its AI, else the app
  icon) above the greeting; the mark and greeting centred in the space between the one thing at the top and the
  suggestions above the card; the box never focused by itself on a phone (load, a tab switch back).
- `components/chat/Composer.tsx`: a `card` layout for phones: the text on top, one row under it inside the box with
  + · the engine picker (only with two or more engines, TC-182) · mic · send, each a 44 px target; no row under the
  box. Used by `NewChatComposer` on Home only. The chat page's box (`/c/:id`) keeps its one-row box and the picker
  under it: its bottom is for the messages and the keyboard, and the owner's screenshot is Home.
- `components/chat/EngineSheet.tsx`: a pill look for the picker inside the card.
- The card sits right on the keyboard (`--app-h`, `.keyboard-open`), the tab bar back when it goes.
- Computers unchanged.

Out: the bottom tabs, `lib/tabs.ts`, `lib/screens.ts`, `Sidebar.tsx` and Projects (another branch is changing them);
the chat page's box; the greeting's words (kept in all 5 locales).

## Steps

1. Plan (this file).
2. `Composer.tsx`: `card` prop; on phones the field and the tool row stacked inside the box.
3. `EngineSheet.tsx`: `pill` look.
4. `NewChatComposer.tsx`: pass `card` through; `Home.tsx`: the mark, the centred head, the dock's bottom with the
   keyboard up, no autofocus on phones.
5. e2e `phone-home-centered` (Chromium and WebKit, 390×844 and 360×780): greeting centred in the free area, the
   card's controls (44 px), no "Default AI" line outside it, nothing focused on load or after a tab switch back, the
   tab bar, a tap focuses the box, the card on the simulated keyboard; screenshots of each Home state; 1440 before
   and after.
6. Adjust older specs that measured the old layout (phone-home-projects, phone-composer-keyboard,
   phone-engine-picker) where they assumed the picker under the box on Home.

## Risks

- The same Composer is used in chats, rooms' side chat and projects: the card layout is opt-in (`card`) and phone-only.
- The engine picker moving into the box: its sheet, its label and its test id stay the same.
- No migration. No i18n key change unless a new label is needed (then all 5 locales).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web` once; the new
phone spec and the adjusted ones on MOCK_PORT 4579.

## Result

Filled in at the end.
