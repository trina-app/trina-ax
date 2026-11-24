# A failed built-in tool falls back to a read-only connector; undo names a person with 님에게

- Date (UTC): 2026-11-24 17:00
- Branch: `fix/connector-fallback-undo-particle` (off `fix/sends-verbatim`, #518; rebased onto `dev` once it merges)
- Status: done
- Where: server/src/integrations/connections/tools.ts ("Connected services"), server/src/tools/index.ts (web_fetch),
  server/src/chat/post-to-room.ts (Step.posted), shared/src/api/entities.ts, web/src/components/chat/PostedCard.tsx,
  web/src/i18n (6 languages).
- Version impact: patch: fewer questions when a page will not open, and correct Korean wording on Undo.

## Goal

1. F1 measurement: `web_fetch` got a 403, then the AI asked "Bright Data로 시도해 볼까요?" and the person had to repeat
   the request three times. When a built-in tool fails and a connected service has a tool for the same job that only
   reads (its annotations, the #426/#404 read tiers), the AI uses it without asking. General guidance and tool
   descriptions only: no service names in code or prompt.
2. The Undo line for a 1:1 chat read "박준호에 보낸 글을 지웠어요". A person reads "박준호님에게"; a room stays "<방>에".

## Scope

In:
1. "Connected services" gets one general line: a built-in tool that failed (blocked, 403, empty) and a listed tool that
   does the same job and only reads: use it at once, without asking, and say in one line which was used. A tool that
   changes something still goes through its card. In a shared chat the one-time connection notice (#440/#502) is the
   only guard. `web_fetch`'s description and its failure text say the same. Pins re-recorded.
2. `Step.posted.toPerson`: the server marks a post to a 1:1 chat (made or not yet made) and gives `to` as the person's
   name; the card picks the person wording (posted / undone / undone with notices) in ko, en, ja, zh, es, id. A room
   and a group chat keep the room wording.

Out: the read tiers themselves, the card rules for tools that change something.

## Tests

- Unit: the Connected services text and web_fetch description/failure carry the fallback rule and no service name; a
  read-only connected tool runs with no ask after a web_fetch failure; a change tool still shows its card.
- share-card: Undo text per recipient type (room, 1:1 known, 1:1 not in the list, group chat) and the Korean particle.
- Real check (QA token, one lane): a private copy with a stand-in scraper MCP; the 403 page scenario 3 times, plus 3
  held-out requests where another connector is the fallback. Raw counts per run.

## Result

Real check on a private copy (QA token, one lane, Claude Code engine) with stand-in services behind a quick tunnel: a
site that answers 403, a page scraper, market data, weather and a code host (each read-only; the code host also has a
change tool). No limit error.

| Run | Cards | ask_user | web_fetch | Expected connector | Other connector | Write calls | Done |
|---|---|---|---|---|---|---|---|
| Round 1 (first wording) F1 x3 | 0/0/0 | 0/0/0 | 1/1/1 | 1/1/1 | 0/0/0 | 0 | 3/3 |
| Round 1 held-out quote / weather / issue | 0/0/0 | 0/0/0 | 1/1/1 | 1/1/0 | 0/1/1 | 0 | 2/3 (issue: asked the person after the scraper's sign-in wall) |
| Round 2 (final wording) F1 x3 | 0/0/0 | 0/0/0 | 1/1/1 | 1/1/1 | 0/0/0 | 0 | 3/3 |
| Round 2 held-out quote / weather / issue | 0/0/0 | 0/0/0 | 1/1/1 | 1/1/1 | 0/1/1 | 0 | 3/3 |

Round 1's miss led to the final wording: pick by what the request is about, and try the next fitting tool before asking.
Round 1 answers also said "읽기 전용" to the person; the final wording asks for one plain line, and round 2 had none.
