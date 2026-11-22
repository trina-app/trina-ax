# One card rule for every connector tool: "Always allow" holds in every chat, plain words, a plain read asks nothing

- Date: 2026-11-22
- Status: accepted
- Supersedes: the "can't tell" card of [Read-only marks in shared chats](20261118-shared-readonly-tools.md) (its
  "Always in this chat", and the card for a read-only tool whose verb is not known); in
  [Connected services in shared chats](20261118-shared-chat-connections.md) "Always in this chat" on the shared card
  (now for good, except with a guest) and "every change asks every time, no Always" (now: only a change that reaches
  other people or a team connection's service)
- Branch: fix/connector-always-allow (the owner, 2026-11-22, four live cards in one day)

- **Ask:** the owner, on four cards: Bright Data's Scrape as Markdown in a shared project chat ("트리나는 이름만으로는
  확인할 수 없어요…", [이 대화에서 항상]): "진짜 의심이 너무 많아. 그리고 이 세션에서만 항상 허용이니깐 이걸 매 세션마다
  봐야하는거잖아"; Aside's shared chat card ("AI가 Aside을(를) 쓰려고 해요… 5명에게 보여요", radios, 이 채팅에서 항상 허용):
  "이것도 너무 많아.. 매 대화마다 해야한다니.."; Aside's Repl ("AI가 Aside에 이 내용을 보내려고 해요: Repl", only
  보내지 않기 / 보내기): "매 콜마다 해야하네"; the same card showing its JavaScript: "코드를 보여주면 뭐 어케 하라는거냐".
  Then: "aside 뿐만 아니라 general하게 고쳐야하는거 알지?"
- **Rule, one card path (`integrations/connections/tools.ts`):** every connector tool (a remote MCP service, an app on
  the person's computer, a Google app, an HTTP API) goes through the same three gates in order: the shared chat card
  (`sharedGate` → `chat/turn.ts` confirmSharedConnection), the read card (`unsureGate`) and the change card (`gate`).
  The read card and a shared chat's change card share one builder (`cardWithAlways`); the private chat's change card
  keeps its per-connection Always (`integrations.write_policy` / `integration_user_allow`, already in every chat).
- **Rule, which read-only tools ask (`read-mark.ts` readKind):** a tool the service marks read-only (`readOnlyHint` and
  not `destructiveHint`) never asks in the person's own chat (unchanged). In a shared chat it is a read with no card when
  its name is plain ASCII and neither name nor title holds a change word, whatever its verb (`scrape_as_markdown`,
  `crawl_site`). Two cases keep the read card: a look-up whose change words are only nouns (`get_post`:
  `nounRead`); a verb that can put the result elsewhere or change a state (`export`, `download`, `check`).
  Look-ups whose own input schema takes a recipient (`to`, `cc`, `channel`, `webhook_url`, `share_with`,
  `phone_number`…) are changes: their card keeps the recipients in view and offers no Always (plan and code review).
- **Rule, Always allow for good (`connections/tool-allow.ts`, migration 441 `connector_tool_allow`):** every connector
  card offers 항상 허용 on its first showing, kept per person and per connection: per tool for the read card and a
  shared chat's change card (Claude Code's "Yes, and don't ask again" keeps one tool, `mcp__server__tool`), and for the
  connection on the shared chat card ("what it returns may show to the people here", tool `''`). Each counts in every
  chat until the person removes it in Settings › Allowed for Trina (`connector_tool` rows, "Bright Data · Get post",
  "Aside · Show what it returns in shared chats"). It counts only while the connection has the address it had when
  chosen and is signed in to the same account (`sharedBind`; a stale row is removed when Settings lists them), while the team's "Always allow" switch is on (`roomAlwaysAllow`;
  off: rows are ignored and no card offers Always), in a turn the person watches from their own app or their own
  scheduled run (also one another person's words steer: Rule A; since #403 a scheduled run is left out only while a
  guest is among the people and another person's words steer it, `steerableRun`), never in a confidential chat, in a
  shared chat with a guest among its people (below) or on a demo server.
  It goes when the account is disabled or removed, and when a team connection's rule no longer includes the person
  (`pruneMemberAllows`). Rule A: once given it is final, also when more teammates join the chat.
- **Rule, what keeps asking:** a call that reaches other people asks every time in a shared chat, with no Always: a
  tool whose name or title says it sends, posts, mails, messages, replies, shares, invites, publishes, notifies,
  schedules or changes access, or is not plain ASCII, or whose schema or call takes a recipient (`ownActTool`), a Google
  app's sending tool, every HTTP API request (some APIs act on a GET), a change at a team connection's service (other people's things are there), and any call with team
  files. With a guest (someone outside the team) among the people of a shared chat, the shared chat card, the read card
  and the card of a change on the person's own things offer and keep "Always in this chat" only (for the people who see
  it then: someone new asks again), and an Always for good given elsewhere is not used there (review of #404;
  `chatAlwaysPlaceOf`, `chat_card_approvals` kinds `shared_unsure_tool` and `shared_own_act`).
  The card goes to the asker only, and the answer's read record still hides it from a later joiner who may not use
  the connection (20261118-shared-chat-connections.md).
- **Rule, words and one press:** the question says what happens in plain words; three buttons (Allow / Always allow /
  Don't allow, `buttons: true`), one line under them saying what Always covers and that Settings removes it. The read
  card: "Bright Data에서 이 페이지를 읽어 와요 · m.blog.naver.com/…" (one web address in the call: host and path, ≤ 60
  characters) or "Bright Data에서 읽어 와요: Get post". The shared card: "AI가 Aside에서 가져온 내용을 이 채팅의 5명이
  함께 봐요." (no particle after a service or tool name: a name's particle cannot always be told). A change on the person's own things: "Tasks에서 “할 일 만들기” 작업을 해요" style ("Create a task in Tasks"). Code an app on the computer runs (Aside's repl, a declared CLI's script): the
  generic line with the title the AI gave the call said as the AI's ("Aside에서 작업을 실행해요 · AI 설명: 열린 탭 확인":
  the call carries it, so it is never stated as fact; code review), and the code,
  parameters and ids only behind one "자세히" (`ConfirmDetail.hidden`). A call that reaches other people keeps "send"
  and its recipients in view (security review of #1338, L2).
- **Consistent with:** Rule A (20261116-always-allow-final-rule-a.md), local-app connectors (20261118-local-app-connectors.md:
  ask card + Always allow, no stricter than the tool), the ask-less rule (20261122-ask-less.md: Claude Code is the
  floor; a single choice is one press).
- **Risk taken:** a service that marks a sending tool read-only and names it with no change word and no recipient
  argument runs with no card in a shared chat, as it already did in the person's own chat; a tool that acts on the
  person's own connection and whose name hides that it sends goes without a card after the person's Always. The
  service is one the person chose, and the owner rejects teammate-injection guards on top (Rule A).
- **Tests:** `tests/unit/b-connector-tool-always.test.ts` (a team MCP connection: no card for the scraper; the read
  card's words and buttons; Always in chat A → none in chat B; Settings lists and removes it; another person; address,
  team switch, lost access), `tests/unit/b-shared-chat-connections.test.ts` (a personal MCP connection: the shared card
  for good across chats and a new teammate, a guest keeps it per chat; a change's card with Always for its tool),
  `tests/unit/c-local-apps-always.test.ts` (an app on the computer, Aside: the repl card's plain words, hidden code,
  Always in private and shared chats), `c-connector-approval-gate.test.ts` (Google-app-like and HTTP API cards),
  `b-shared-readonly-tools.test.ts`, `b-shared-readonly-calltool.test.ts`, web `ask-card-exact.test.tsx`.
- **Version impact:** patch (fewer cards, a remembered choice, plainer words; one additive table).
