# Phones: Connectors scrolls as one page, 44 px links, Google Drive in the app offers no sign-in (QA TC-262 step 1)

- Date (UTC): 2026-11-12 03:56
- Branch: `fix/phone-connectors-scroll`
- Status: in progress
- Where: web/ (pages/Connectors.tsx, components/integrations). Why: the phone app shows the web app, so the fix is in
  the web app's phone layout (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a phone layout fix with no new feature or API

## Goal

QA TC-262 step 1 (owner: "커넥티드 앱 쪽도 모바일 최적화 안 됨"; "어차피 연결은 못하지 않나?"): Me › 연결한 서비스, tap +,
open Google Drive → "Status and Disconnect only, one line 'connect on a computer'; plain list, search scrolls away,
44px". Checked on an Android device: the + sheet and the plain list pass; three things fail or were not checked.

## Scope

In:
1. Below 768 px the page's description, the search box and "Add custom connector" are part of the page and scroll
   away with the list (today the sticky title bar holds them, about 185 px). Computers and tablets keep the sticky bar.
2. 44 px tap areas on phones for the small text links: Discover's "Show all (n)" / "Show less", a card's "Set up", the
   rows' open buttons and status links; Admin › Connectors' "Show all →" (ConnectorsView.tsx). They keep looking like
   text links.
3. Inside the phone app, Google Drive's page (and the Google apps' pages, which work the same way): no Connect,
   Reconnect or "turn on and connect" button and no Google sign-in; the status (Connected, the account, Reconnect
   required, why it is off) and Disconnect only, plus one line "Connect Google Drive on a computer." when it can be
   connected there. A Discover + for a built-in one opens its page without starting Google. A member whose team has not
   set it up keeps "Ask admin to add it" (it works on a phone). A browser on a phone and computers are unchanged.

Out: Admin › Connectors' Google Drive page layout (TC-266, another session); the team-template connect dialog
(TemplatesView.tsx, PR #542 is changing it); the shared Button/IconButton defaults (TC-189).

## Steps

1. Connectors.tsx: a phone renders the header block in the page's flow (not PageHeader's sticky bar); same contents.
2. The tap areas above (`max-md:min-h-11`, rows kept at their height).
3. DrivePage and GoogleAppDetail: in the app (`mobileApp()`), the actions and line as above; Discover's + only opens
   the page there.
4. e2e: `web/test/e2e/phone-connectors.cases.ts` with a Chromium and a WebKit spec (390×844, touch, the app bridge
   stub), following the row's steps; a 1440 screenshot before and after.

## Risks

No migration, no API change. Copy reuses existing keys (`integrations.onComputer`). Desktop and tablet must look the
same (1440 screenshots). PR #542 changes nearby lines of Connectors.tsx (an import, the row status); this branch stays
off those lines.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`, `bun run test:web`, and the new
phone e2e specs on their own port.

## Result

Filled in at the end.
