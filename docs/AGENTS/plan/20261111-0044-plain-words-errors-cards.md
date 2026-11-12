# Plain words in chat errors, the AI's confirmation cards and step lines

- Date (UTC): 2026-11-11 00:44
- Branch: `fix/plain-words-errors-cards`
- Status: done
- Where: trina-ax core (`shared/src/api/errors.ts`, `shared/src/step-labels.ts`, `server/src/chat/i18n.ts`,
  `server/src/integrations/connections/`, `server/src/tools/url-gate.ts`, the cards that name team paths, the chat's
  error box and card details in `web/`). Why: chat, cards and steps are core (see docs/REPOSITORY-RULES.md).
- Version impact: patch, new wording and one optional card field (`ConfirmDetail.exact`); no data change

## Goal

Trina AX is used by office workers, not developers. The plain-words audit (2026-11-10, items 3, 5, 6, 11 and 15) found
the developer words concentrated in what the server sends: chat errors that name engines, proxies, APIs and "HTTP 502";
confirmation cards that show `create_task`, a JSON dump, raw paths and a SHA-256; step lines with snake_case ids, raw ids,
engine and model names and an English " (job)". This is PR 2 of the plain-words fixes: say what happened, who to tell,
and what is about to happen, in words a person reads in a few seconds.

## Scope

In:
- Chat errors: new wording for every `CHAT_ERROR_MESSAGES` reason (no engine, proxy, API or HTTP code); the old texts
  stay for matching stored errors. The admin menu path is added on screen only for the owner and admins, built from the
  menu's own labels. No " (HTTP NNN)" in the text (the status stays in `params.status`). Engine and safe-ops refusals
  in plain words.
- Connected-service cards: the tool's title (MCP `title`, else the id as words); every value as a labelled line; the exact
  JSON one click away ("Show exactly what is sent"); long random-looking parts highlighted in both. Same approve and deny
  behaviour, same size limit. The HTTP API variant names the action and the address in words.
- The new-address card in plain words. The save-to-wider-audience card names the place in words and no longer shows the
  SHA-256 (it stays in the activity log).
- Step lines: no snake_case fallback, no raw ids or arguments, no engine names or model ids, no English " (job)"; plainer
  verbs. Old stored steps still follow the language on screen.
- Raw paths on server cards (move/copy, trash, room change, sources, team skill save) and in the "save it in my folder"
  draft: place words (전사 공유 › 영업, 내 폴더, 팀 스킬).
- Google Drive sign-in failures in words, not reason codes.

Out: the web-only wording of the audit (Settings › Connections, MCP, model id under answers, onboarding, permissions)
goes in the other plain-words PRs.

## Steps

1. Errors: shared table, server `engineError`, web error box with the role-aware hint.
2. Cards: `ConfirmDetail.exact`, connection card lines and title, address card, wider-audience card.
3. Step labels and their legacy matching.
4. Place words on server cards and the web draft.
5. Tests, e2e, screenshots, review.

## Risks

- Confirmation cards are a safety net: everything sent must stay reachable and highlighted, approve and deny unchanged,
  and a service's tool title must not be able to fake the card's text (one line, cut, invisible characters out).
- Stored errors and steps keep their old words: matching keeps the old texts.
- Five languages for every new text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; unit tests of `chat/*`, `integrations/connections/*`,
`tools/url-gate*`, `step-labels`, the error mapping and the card rendering; `bun run test:web`, `bun run build:web`; e2e of
the chat error box, a connection card and the steps list.

## Result

PR #348. Built as planned, plus what the independent review asked for: the card's lines show each text exactly as
sent and are made only when nothing would be lost (no collapsed spacing, no invisible characters, names at most 40
characters); same-named people and top folders named like a place are told apart; the id-to-words helper is linear.
Also in: save_url's redirect card and the no-exit-address card in plain words (no "office"), the web's safe-operations
texts matching the server's, and room_read's "The the team's room for everyone". Left for later: the Google Drive
routes' error codes, background job exception text, the English-only dev-environment card, the in-app browser's
office-address card, the skill-move card's path box (docs/DECISIONS.md "Plain words in errors, cards and steps").
