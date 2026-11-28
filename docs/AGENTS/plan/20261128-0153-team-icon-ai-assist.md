# Team logo from the website: the team's AI checks the pick and finds the logo when the rules find none

- Date (UTC): 2026-11-28 01:53
- Branch: `feat/team-icon-ai-assist`, stacked on `feat/team-icon-from-site` (PR #711, head 97be1e5b0)
- Status: done
- Where: server/src/onboarding (new `site-icon-ai.ts`, `svg-raster.ts`), the restricted-turn plumbing in
  server/src/chat (turn.ts, tools.ts), admin/team-icon-site.ts, onboarding/welcome-result.ts, the two web screens.
  Why: the website-logo feature (#711) is rules only; the owner asked for the team's own AI to check and to find
  (docs/REPOSITORY-RULES.md: onboarding and admin areas, B owns the onboarding turns).
- Version impact: minor. A user-visible change of an unreleased feature (#711) and two additive API fields plus one
  new read endpoint; nothing removed.

## Goal

Owner (2026-11-28): "AI가 연결돼 있으면, 규칙이 고른 후보를 AI가 한 번 더 보고 '이게 진짜 로고인지' 확인" (ㅇㅇ) and
"AI 쓰면 토코피디아 저런거 로고 가져오는거 일도 아닐건데..". The rules-only QA of #711 found nothing for 9 of 23 sites
(fritzcoffeecompany, terarosa, andersson-bell, mmmg, sixshop, gojek, kopikenangan, patagonia, tokopedia: slow
sites, bot checks, SVG-only or small icons, wide wordmarks) and once took a product photo for a logo.

When the person who pressed has a working Claude Code or Codex connection:
1. **Verify:** the AI looks at the rule-picked picture (the actual bytes, as the team logo would be) and says yes/no.
2. **Find:** when the rules found nothing, or the AI said no, the AI looks for the company logo with its own web
   search and our guarded fetch, the way a person would, and names one picture it looked at.
Without AI (common at onboarding) nothing changes.

## Design

- **One restricted chat turn, reused path.** `onboarding/file-rank.ts runFilesTurn` already runs one hidden,
  time-limited turn of the caller on their own engine connection, budget and usage (marked in
  `onboarding_file_ranks`, out of the chat list, deleted after, swept if left). The logo task is one more material
  kind there (`kind: 'team-icon'`), like the folder plan (`kind: 'organize'`). No migration, no new engine call, no
  new chat type. Hidden, counted in usage (the turn row stays, as for every rank).
- **Its tools:** only `logo_look` (ours) and the engine's own web search (Claude Code WebSearch; Codex web_search on
  the cached index), nothing else: no team files (the always-listed file tools are refused), no web_fetch, no
  browser, no sub-agents, no skills, rules, memories or project.
- **`logo_look {url}`** (the AI only proposes; our code fetches and decides): one address, fetched by
  `brand-assets.ts fetchBytes` (web_fetch's guard: public unicast only, this server's exit addresses refused, pinned,
  every redirect hop re-checked, ports 80/443, no cookies, size caps). A picture (PNG, JPEG, WebP, ICO's PNG, or SVG
  rasterised, below) goes through the same `judgeIcon` (≥ 64 px, long/short ≤ 1.25, ≤ 40 MP) and `normaliseIcon`
  (square 256 px PNG on a tile) as the rules, and must pass `checkTeamIcon`; the AI then **sees that PNG** (an MCP
  image, the team's image switch and budget as any tool image) with an id `L1`…; a picture that fails gets the reason
  in words (too small, too wide, not a picture). A web page gets the list of icon and logo addresses it names (the
  rules' `iconCandidates`, plus SVG and wide logos the rules skip), no text of the page. At most 8 calls per task.
  The rule pick's own address returns the rule's already-made picture (no second fetch).
- **The answer:** one JSON `{"logo": "L2" | null, "why": "…"}`. Our code maps the id to the bytes it made and checks
  them again (`checkTeamIcon`); an id it never made is unclear.
- **Decisions by our code:** AI picks Lx → that picture. AI says null **after looking at the rule pick** → nothing
  (verify rejected; the person uploads). No AI, engine error, timeout, no JSON, unknown id, a null without having
  looked at the rule pick → **rules only** (the rule pick if there was one, else nothing). Fail closed = today.
- **SVG** (`onboarding/svg-raster.ts`): only when a logo exists only as SVG. The pinned chrome-headless-shell of
  `scripts/system/packages.json` through `files/html-pdf.ts runBrowser` (the converters' isolation: no network, a
  host resolver that resolves nothing, never root, memory/disk caps), JavaScript off, every request answered by us
  (the page and the one SVG as an `<img>`, which browsers draw in secure static mode: no scripts, no external loads;
  everything else failed), a CSP `default-src 'none'`, a 10 s limit, one print slot (`tryRenderSlot`, skipped when
  busy). Size from the root `<svg>`'s width/height/viewBox (long side 512) so a wide wordmark stays wide and fails
  the square rule. ≤ 512 KiB of SVG. No browser or isolation: skipped.
- **Budget:** at most one AI task per press, 60 s, the engine's small model (Claude Code `haiku`, Codex nano/mini,
  as file-rank picks; else the person's model), low effort. One run at a time per server (the existing `busy`).
- **Background, never blocking:** onboarding's "저장하고 계속" answers at once with `teamIconPending: true` and the
  steps go on; the admin button answers `{ pending: true }`. The result lands later the same way as today
  (`saveTeamIconIfAbsent` at onboarding, a replace-if-unchanged in Admin), audited `team_icon.set` with
  `source: 'site'` and `ai: 'picked' | 'checked'`, `TEAM_ICON_CHANGED` to open windows. The pressing window reads
  `GET /api/admin/team-icon/from-site` (its own last run: running, set + version, none) every 2 s for up to 90 s and
  shows the same toast with 되돌리기 (onboarding) or the same "done" toast (Admin). One new line in Admin while it
  runs ("AI가 로고를 확인하고 있어요…"), six languages.
- **Who:** the owner or admin who pressed, on their own connection (`aiAccessFor`), their budget (`budgetBlock`).
- **Prompt injection:** website text, search results and page lists are data in the instructions. Whatever they make
  the AI ask for, `logo_look` goes through the guard (no private, loopback, link-local, metadata or this server's
  addresses; no other port or scheme), so nothing private can be fetched; the AI never gets bytes it can send
  anywhere (no other tool), and the only thing it controls is which of the pictures it looked at becomes the logo,
  which the person sees with an undo.
- **Codex and Claude Code:** both; the API engine is left out (rules only).

## Steps

1. `site-icon-ai.ts`: material, prompt, `logo_look` tool, candidate store, answer reader, gate, the run.
2. `svg-raster.ts` and its tests.
3. turn.ts / tools.ts: the `team-icon` kind gets `logo_look` and web search; everything else stays refused.
4. Onboarding press and Admin button: background run, state endpoint, `replaceTeamIconIf`.
5. Web: poll + toast (Welcome), pending line + toast (TeamSettings), six languages; mock server.
6. Tests: verify, find, fail closed, budget/timeout, SVG, guard on AI-proposed addresses.
7. QA on a private copy with a real engine on the 23 sites; decision file, changes note.

## Decisions

New: `docs/decisions/20261128-team-icon-ai-assist.md`. Changes `20261128-team-icon-from-site.md` rule "Never SVG"
(only for the AI path's look; the rules stay as they are).

## Risks

No migration. Security: a turn with a tool that fetches any public address the AI names (the guard is the defence,
as for web_fetch); a browser draws an untrusted SVG (isolation, no network, scripts off, static mode). Usage: one
small-model turn per press. Six languages for the one new line. Phone and desktop: the Admin line wraps.

## Tests

Unit (fake engine): verify yes / no, find, fail closed (no AI, error, timeout, no JSON, unknown id, null without a
look), the 8-look cap and the 60 s limit, the tool refusals, private addresses refused for an AI-proposed URL, SVG
dimensions and rasterising (when a browser and isolation are here). Security cases for the guard. Web e2e on the
mock: the pending toast. QA: 23 sites, rules-only vs AI, screenshots.

## Self-review

- Reuses runFilesTurn instead of a second hidden-chat mechanism; the only new turn power is `logo_look` + search.
- The turn sees pictures only after our checks, so "the AI said yes" can never bypass the square/size rules.
- A null verdict only counts when the AI looked at the rule pick: a lazy "null" cannot remove a good rule result.
- Admin replace waits up to a minute: the replace is "only if the logo is still the one before the press", so an
  upload in between wins.
- Open: whether the AI should also run on a shared-platform page (a smartstore's brand); left out (rules skip it).
- Open: the small model may miss logos a bigger one finds; measured in QA, model choice kept in one place.

## Result

Built as planned, with two changes found while building: the onboarding press also runs the AI when the reading kept
nothing (a bot check gives the draft no page, so there was no draft to take a staged icon from), and it asks the AI
once per website (the welcome row's `teamIconAiSite`) so an undone logo stays undone on a later save.

QA (2026-11-28, a private local copy, the real admin route, the 24 sites of #711's QA): the Claude Code QA token was at
its weekly limit, so the run used **Codex** (this Mac's ChatGPT login, local-login mode). Rules only: 14 icons, 9
none, 1 shared platform. With the AI: the 14 rule picks were all kept (verify yes, 8–12 s each); 8 of the 9 "none"
sites got a logo (fritzcoffeecompany, terarosa, mmmg, sixshop, tokopedia, gojek, kopikenangan, patagonia: 20–50 s,
from app-store pages, Wikimedia Commons, the trademark office and the companies' other domains); andersson-bell stayed
none (only a 19 px wordmark and a 28 px favicon exist). Verify no: a product photo staged as the rules' pick for
patagonia was rejected and the AI found the real mark instead. The onboarding press answered in 0.05 s; the logo
landed 22–26 s later. Screenshots: the session scratchpad's ticon-ai-shots/.
