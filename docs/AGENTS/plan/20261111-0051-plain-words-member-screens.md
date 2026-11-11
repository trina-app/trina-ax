# Plain words on the screens members see (plain-words PR 1)

- Date (UTC): 2026-11-11 00:51
- Branch: `fix/plain-words-member-screens`
- Status: in progress
- Where: trina-ax core (web i18n, `pages/Integrations.tsx`, `components/integrations/ConnectorsView.tsx`,
  `components/SearchDialog.tsx`, `components/chat/Messages.tsx`, one server notice string, docs). Why: the words are
  core UI in all five languages (see docs/REPOSITORY-RULES.md)
- Version impact: patch, words and two small visibility changes; no API, data or permission change

## Goal

Trina AX is used by ordinary office workers, almost never developers. A plain-words audit of `dev` found the developer
words concentrated in a few places. The owner approved its top 15 and two decisions:

- Members do not add a service by its address. The form stays for owners and admins; members read "Not listed? Ask an
  admin to add it." The admin adds it, or asks the member with the existing request ("Ask a member to connect…").
- The design-system copy rule listed "AI engine" as a user word. It becomes "AI"; member-facing strings say "AI" or the
  AI's name instead of "engine".

This PR does the member screens. Chat errors, the AI's confirmation cards and step labels are server-sent text and
another PR does them.

## Scope

In:
- Settings tabs and the same Admin pages, one plain name in both (the container says whose, as #289 decided):
  Providers → **AI accounts**, Connectors → **Connected apps**, AI apps → **Use from other AI apps** (ko AI 계정 ·
  연결한 서비스 · 다른 AI 앱에서 쓰기). The page lines, "Codex" section → "ChatGPT", the words on the connectors page
  (top, more, search) and every pointer to these pages ("Settings › MCP", "Admin › Providers or Connectors",
  "the AI engines page", the server's schedule notice).
- "MCP" off member screens: the empty line, the search tab and action, the onboarding tools step, the notification,
  "Other MCP apps".
- The model id under each answer: hidden; people who may choose the AI get its plain name ("Claude Sonnet") on a small
  info button (tooltip, and a toast on touch).
- Members: no "Add" button and no address link on Settings › Connected apps, no address form from Search (`?add=1`);
  "Ask an admin to add it." instead. Owners and admins keep both.
- i18n-only items of the rest of the top 15: AI-apps page words (connection address, the footer), the Files
  "pass-through" chip and its tooltip, "conflict copy", the skill-suggestion and skills-folder lines without raw paths,
  the project members dialog's "rules" words, the member usage page's token/API words, the owner onboarding's
  "AI engines page".
- "Engine" in member-facing strings: composer picker, Settings › Profile "AI for new chats", the engine-switch line,
  the dev-mode banner, the owner's AI-settings notice, search words.
- DESIGN-SYSTEM copy rule, DECISIONS entry, `changes/plain-words-member-screens.md`, the docs site's menu names.

Out:
- Chat errors, confirmation cards, step labels (server-sent; the other plain-words PR).
- Structural changes the audit also proposes: folding Claude Code under "For developers", dropping the members' token
  tile, plain model names in usage rows, collapsing the onboarding skills block, the draft prompt that names
  `users/<id>`, raw error codes (item 15). Hardcoded engine labels (`ENGINE_LABEL`) stay.
- A member → admin request in the app: no such flow exists (the existing one goes admin → member). Open question.

## Steps

1. Plan (this file).
2. i18n values in ko, en, id, ja, es; two new strings.
3. Code: the member add path, Search's action, the answer footer.
4. Server notice pointer; DESIGN-SYSTEM; DECISIONS; changes file; docs site names.
5. Tests that assert the old words; screenshots at 1440 light in Korean.

## Risks

- Strings appear in many e2e specs: run the full web e2e once.
- Open branches touch the same area: `batch/phone-settings` (the Settings nav: this PR changes only labels),
  `feat/project-members-only` (the project members dialog strings).
- Five languages: `bun run check:i18n` must stay at 0.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the unit
tests of the touched areas, the settings, connectors, search, onboarding, chat and notifications e2e specs, then the
full web e2e.

## Result

Filled in at the end.
