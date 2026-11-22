# Team tools step: Higgsfield in place of Slack

- Date (UTC): 2026-11-22 00:19
- Branch: `feat/onboarding-tools-higgsfield`
- Status: done
- Where: web (onboarding ToolsStep, Settings › Connectors), docs. Why: the owner finds Slack's connection too
  complicated for the first steps; Higgsfield (AI images and video) connects with one sign-in.
- Version impact: patch. The welcome step shows a different listed tool; no API, data or setting changes.

## Goal

The owner's 팀이 쓸 도구 step lists Notion, Higgsfield, Google Drive and Gmail. Slack leaves the top rows and stays
reachable: Admin › Connected apps › Slack, and "다른 도구 보기" (Settings › Connectors) for an owner or admin.

## Facts checked (2026-11-22)

- Higgsfield's MCP server: `https://mcp.higgsfield.ai/mcp`, sign-in in a Higgsfield window, no API key
  (https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent).
- `initialize` without a token: 401 with `WWW-Authenticate: Bearer resource_metadata=…/.well-known/oauth-protected-resource/mcp`;
  the protected resource names `https://higgsfield.ai/_clerk` (Clerk), which offers dynamic client registration,
  client metadata documents and PKCE S256. `bun run check:connectors -t higgsfield` passes. A registration with the
  qa.trina.app callback is accepted and its authorize address leads to Higgsfield's sign-in page (no account used).
- Higgsfield is already a listed service (`shared/src/service-catalog.ts`), with its logo
  (byte-identical to https://higgsfield.ai/apple-icon.png) and `integrations.catalog.higgsfield` in all six languages.

## Scope

In:
- `ToolsStep.tsx`: `WELCOME_SERVICES = ['notion', 'higgsfield']`, the same team row as Notion ([팀으로 연결], one team
  connection everyone may use) with the "각자 연결하도록 권하기" switch. The Slack row goes; a Slack connected elsewhere
  still counts as a working team tool (the done screen and the server already count it).
- Settings › Connectors: for an owner or admin whose team has not added Slack, a Slack card in Discover that opens
  Admin › Connected apps › Slack (the same rule as the Admin card: an admin only where Add to Slack is offered).
- The logo's source recorded next to it.
- Docs: `docs/CONNECTIONS.md`, `docs/site/**/get-started/team-setup.md` (6 languages), the `setup/tools-step` screenshot.
- Tests: the welcome unit and e2e tests that pin the rows; a Slack card test for Settings › Connectors.

Out: the skills step, the intro deck, the company-profile fetch (other agents). My setup card's default tools.

## Steps

1. Plan (this commit).
2. ToolsStep rows and comments; Settings › Connectors Slack card; logo source.
3. Tests; docs; screenshot `--mock --only setup/tools-step`.
4. typecheck, check:prepush, check:docs, onboarding and connector unit tests. PR into dev, not queued.

## Decisions

Higgsfield's row is like Notion's: team connect plus the switch. A shared account works (one OAuth sign-in; Higgsfield
has team workspaces whose credits the members share), and a person who has their own plan connects their own. Nothing
is switched on by default, as for every row. No new decision file: it applies
docs/decisions/20261120-team-vs-personal-onboarding.md.

## Risks

None in data or permissions. Higgsfield's tool list is large (about 1 MB); connections already keep up to 1,000 tools.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:docs`, web unit `welcome`, `connectors`, e2e
`welcome-tools.spec.ts`.

## Result

Built as planned. Also: each team row's line now says what the tool does ("팀 전체가 이 연결을 같이 써요 · AI로 이미지와
영상을 만들어요"), because Higgsfield is less known than Notion; `welcome.tools.slackLine` is gone. Higgsfield was already a
listed service with its logo and descriptions, so no catalog change was needed beyond recording the logo's source.
Settings › Connectors had no Slack card for a team without Slack, so "다른 도구 보기" would not have reached Slack; the card
was added. The screenshot shows Notion, Higgsfield and Gmail (the mock has no Google Drive).
