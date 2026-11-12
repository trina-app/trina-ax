# Connectors (#399) taken over: onboarding's Tools step on the same cards, and what #534 left

- Date (UTC): 2026-11-12 02:00
- Branch: `feat/connectors-simple` (PR #399, taken over by session trina-ax-1e; rebuilt on dev after #534)
- Status: in progress
- Where: `web/`. Why: connectors and onboarding are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a step that connects in one click; nothing new to set up

## Goal

The simple Connectors page (QA TC-179: Your connectors + Discover, the name Connectors, no tab in Settings) landed on
dev through #534 ("rebased, supersedes #399") while this PR was being taken over. That PR also kept dev's ask-an-admin
flow, the never-signed-in rows and the server texts. So this branch is rebuilt on dev and carries only what is still
missing:

- **QA TC-136:** onboarding's Tools step shows the same connector cards as Connectors (logo, name, one line), and
  Notion's sign-in opens in one click with no name or address to type. The TC sheet's TC-145 follows: without a Google
  client the step shows an honest status, and the address form is not the only choice.
- **Phones (TC-179's phone notes):** 44 px hit areas for "모두 보기", "Set up" and the row's status buttons.
- **A dev e2e test** broken since #512: connectors-hub's check of the closed Advanced line still expects "API".

## Steps

1. `components/onboarding/ToolsStep.tsx`:
   - Google Drive as before when this server has it; otherwise its card with "아직 설정 안 됨", never a hidden row.
   - The first listed services (Notion, Linear, Atlassian, Canva, Figma) as cards. One 연결 makes the owner's own
     connection (`POST /api/integrations`, the list's address, sign-in) and opens its sign-in in the window reserved
     during the click. The card shows the sign-in's state, then "연결됨". One already there shows where it stands.
   - "다른 도구 연결하기" (the address form, a team connection) stays last.
2. docs/DECISIONS.md: the step's new shape (it changes W6).
3. `pages/Connectors.tsx`, `ConnectorsView.tsx`: `touch-hit` on the small controls.
4. Tests: `welcome.test.tsx` (the Drive card when not set up and the five service cards; Notion in one click),
   `welcome-tools.spec.ts` (the same in a browser), the connectors-hub fix.

## Risks

- Personal connections turned off by the team: the 연결 says why (the server's 403 text). On a new team they are on.
- The owner's own connection, not a team one: nobody else uses their Notion. The address form still makes a team one.
- No migration, no permission change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests, the welcome and connectors e2e specs
(heavy.sh).

## Result

