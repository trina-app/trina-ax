# Desktop team list: a visible "Open" on each other team

- Date (UTC): 2026-11-21 17:51
- Branch: `fix/team-list-open-first`
- Status: in progress
- Where: desktop/src/ui (the app's own team screen). Why: only the desktop app keeps a list of teams (docs/REPOSITORY-RULES.md)
- Version impact: patch, a small UI fix on an existing screen with no new behaviour

## Goal

User feedback: "팀 전환할 때 remove 보다 open이 먼저 보이고 remove는 더보기 버튼 같은 걸로 보이는 것도 괜찮을 것 같습니다!
클릭하면 팀 전환이 된다는 걸 2번째 시도에서 알았어요". The screenshot came from an app older than 0.5.8: there the row
showed only an outlined "Remove from list". Since 0.5.8 (8ff0258bb) Remove is in the row's "···" menu, but a row for
another team still shows nothing that says a click opens it. People should see "Open" first.

## Scope

In:
- Desktop team list (`desktop/src/ui/welcome.ts`, `ui.css`): each row that is not the open team shows a small outlined
  **Open** (the app's plain secondary button look, never the orange primary that Connect uses). It is part of the row's
  one button, so the whole row still opens the team and there is one tab stop per row.
- The open team keeps its quiet check and "Current" (no Open there).
- The row's accessible name is "Open {team}" for other teams; the address stays its description.
- "···" keeps Remove from list and its confirmation, unchanged. On a touch screen the "···" is 44px.
- One new string `welcome.openTeam` ("Open {team}") in all six desktop languages; the visible word reuses `welcome.open`.

Out:
- Phone app: it holds one team, no list (its "Connect to another team" screen takes an address).
- Web/PWA in a browser: "Switch team" is a dialog that takes an address, no list. In the desktop app it opens this screen.

## Steps

1. Plan (this commit).
2. welcome.ts + ui.css + i18n key.
3. Unit test (source check like tests/unit/e-desktop-common.test.ts) and the desktop e2e (open the other team by its Open).
4. changes/team-list-open-first.md.
5. typecheck, check:prepush, area tests (Bun 1.3.12); before/after shots 1440 and 390, light and dark.

## Decisions

none (follows docs/DECISIONS.md "Desktop team list: one row per team").

## Risks

Long team names at 390 px: the name ellipsizes before the Open. No server, migration or permission change.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun test tests/unit/e-desktop-common.test.ts`, desktop e2e team list test.

## Result

(filled in at the end)
