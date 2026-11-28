# With the team's AI, the website logo is checked by the AI and found by it when the rules find none; the server decides

- Date: 2026-11-28
- Status: accepted
- Supersedes: none (extends [20261128-team-icon-from-site.md](20261128-team-icon-from-site.md))
- Branch: feat/team-icon-ai-assist, stacked on feat/team-icon-from-site (PR #711); plan
  docs/AGENTS/plan/20261128-0153-team-icon-ai-assist.md

- **Ask:** the owner, 2026-11-28: "AI가 연결돼 있으면, 규칙이 고른 후보를 AI가 한 번 더 보고 '이게 진짜 로고인지' 확인"
  (approved: "ㅇㅇ"), and "AI 쓰면 토코피디아 저런거 로고 가져오는거 일도 아닐건데..". The rules-only QA of #711 found
  nothing for 9 of 23 sites (a bot check, a slow site, SVG-only or 32 px icons, wide wordmarks) and once took a product
  photo for a logo.
- **Rule, when:** the press (the onboarding "저장하고 계속" while the team has no logo, or Admin › 팀 로고 › "홈페이지에서
  가져오기") gets the AI's help when the person who pressed has a working **Claude Code or Codex** connection that
  answers them (their own connection and budget, `aiAccessFor`, `budgetBlock`), the team sends pictures to the AI
  (Team settings' image switch), the server knows its exit address (or the install turned that check off) and no other
  run is going. Otherwise, and always for the API engine, the rules alone, exactly as #711. The onboarding press asks
  the AI once per website (the welcome row's `teamIconAiSite`), so a logo undone stays undone on a later save.
- **Rule, what it is:** one task per press: a hidden chat of the presser marked like 팀 파일's picks
  (`onboarding_file_ranks`, material `kind: 'team-icon'`, run by `runFilesTurn`: out of the chat list, deleted after,
  swept if left; its turn row and usage stay, counted as the presser's like any chat). The engine's small model
  (Claude Code `haiku`; Codex nano or mini when its catalog has one, else the person's model), low effort, **60 s**.
  Its only tools: `logo_look` and the engine's own web search (Claude Code WebSearch; Codex web_search on the cached
  index). Team files, web_fetch, the browser, sub-agents, skills, rules, memories and projects are not there; the
  always-listed file tools are refused.
- **Rule, the AI only proposes:** `logo_look {url}` fetches one address through `fetchBytes` (web_fetch's guard:
  public unicast addresses only, this server's exit addresses refused, the connection pinned to the checked address,
  every redirect hop checked again, ports 80/443, no cookies, 6 MiB). A picture goes through the rules' own
  `judgeIcon` (≥ 64 px, long/short ≤ 1.25, ≤ 40 MP) and `normaliseIcon` (square 256 px PNG, a see-through mark on a
  tile) and must pass `checkTeamIcon`; the AI then sees **that PNG** (an MCP image, under the image switch and the
  turn's image budget) with an id `L1`…. A refused picture gets its reason in words (too small, too wide, not a
  picture). A page gives only the list of the icon and logo pictures it names (its manifest's icons too), never its
  text. At most 8 looks. The rules' own pick is shown from its bytes (no second fetch). The answer is one JSON
  `{"logo": "L2" | null, "why": "…"}`.
- **Rule, the server decides:** a known id → that picture (checked again as an upload would be). `null` **after the
  AI looked at the rules' pick** → nothing is set (the person uploads; "not found" in Admin). No AI, an engine error,
  the time limit, no JSON, an unknown id, or a `null` without having looked at the rules' pick → **the rules' result**
  (fail closed = #711).
- **Rule, SVG:** only inside `logo_look`, when a logo exists only as SVG: drawn by the pinned chrome-headless-shell
  of `scripts/system/packages.json` through `files/html-pdf.ts runBrowser` (the converters' isolation: no network, a
  resolver that resolves nothing, never root, memory and disk caps), JavaScript off, the SVG as an `<img>` (secure
  static mode: no scripts, no external loads) on a fixed page with CSP `default-src 'none'`, every other request
  failed, 10 s, one print slot (skipped when busy), at most 512 KiB, drawn at its own shape (the long side 512 px) so a
  wordmark stays wide and the square rule refuses it. No browser or isolation: skipped. The rules still never take SVG.
- **Rule, in the background:** the press answers at once (onboarding: `teamIconPending: true`; Admin:
  `{ pending: true }`) and the steps go on. The result lands like #711's (onboarding: only while the team has no logo;
  Admin: only over the logo that was there at the press, so an upload meanwhile wins: `replaceTeamIconIf`), audited
  `team_icon.set` with `source: 'site'` and `ai: checked | picked | rules (…)`, announced to open windows. The
  pressing window reads `GET /api/admin/team-icon/from-site` (its own last run, kept 10 minutes: running, set with the
  version, none with the words, idle) every 2 s for up to 2 minutes and shows the same toast (onboarding: with
  되돌리기) or the same "done" toast; Admin shows one line while it runs ("AI가 홈페이지 로고를 확인하고 있어요…").
- **Why the guard is enough against prompt injection:** website text and search results can make the AI ask for any
  address, but `logo_look` is the only way out and it refuses private, loopback, link-local, metadata and this server's
  own addresses on every hop; the AI has no other tool to send anything anywhere, and the only thing it controls is
  which picture it looked at becomes the logo, which the person sees with an undo.
- **Why a chat turn and not the file list's reader:** the reader runs on a team-wide account; this runs as the person
  who pressed, on their connection and usage, like their chats (docs: anthropic-claude-code-terms, the team's own
  connection, never ours). Hidden, because it is the server's work, not a conversation.
- **Left out:** shared-platform pages (a smartstore, a Naver blog: the rules skip them, so does the AI); a bigger model
  for hard sites; showing the AI's reason to the person.
- **Tests:** tests/unit/b-site-icon-ai.test.ts (the answer, the decision, the page lists, SVG drawing, the guard on
  AI-proposed addresses, the look cap, the turn's tools and instructions, verify yes / no, find, fail closed, the time
  limit, both presses in the background, replace-if-unchanged); tests/unit/b-site-icon.test.ts (rules alone);
  tests/security team-icon cases (the run state is the caller's own).
- **Version impact:** minor (a user-visible change of an unreleased feature; two additive response fields and one new
  read endpoint).
