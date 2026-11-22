# Connector read tools: "Always allow" for good, and no card for a plain read-only tool

- Date (UTC): 2026-11-22 14:01
- Branch: `fix/connector-always-allow`
- Status: done
- Where: server `integrations/connections/` (read-mark.ts, tools.ts, text.ts), `chat/always-allow.ts`, the
  allowances API (`shared/src/api/ai-allowances.ts`, `routes/rooms.ts`), web Settings › Allowed for Trina. Why: the
  connector card is decided there (docs/REPOSITORY-RULES.md).
- Version impact: patch (fewer cards, a remembered choice; no new screen, one additive table).

## Goal

The owner, on a shared project chat with their own Bright Data connection, asked the AI to read a public blog page and
got: "AI가 Bright Data에서 이 작업을 하려고 해요: Scrape as Markdown. Bright Data 쪽에서는 읽기만 한다고 하지만, 트리나는
이름만으로는 확인할 수 없어요…" with [실행하지 않기] [이 대화에서 항상] [이번만 허용]. Their words: "진짜 의심이 너무 많아.
그리고 이 세션에서만 항상 허용이니깐 이걸 매 세션마다 봐야하는거잖아".

Today (`read-mark.ts` readKind, decision 20261118-shared-readonly-tools.md): in a shared chat a tool the service marks
read-only counts as a read only when its name starts with a strict read verb; `scrape_as_markdown` (no change word, verb
unknown) and noun-reads (`get_post`, `list_pull_requests`) get the "can't tell" card (`unsureGate`), whose Always is
kept per chat (`chat_card_approvals` kind `shared_unsure_tool`, 12 h). Outside a shared chat the service's mark is
taken as it is (no card).

## Scope

In:
1. **A read-only tool with no change word asks nothing, in a shared chat too.** readKind: a tool marked read-only
   (`readOnlyHint` and not `destructiveHint`, unchanged) whose name and title hold no change word is a read in a shared
   chat, whatever its verb (`scrape_as_markdown`, `web_data_linkedin_person_profile`, `export_report`). The shared
   connection card (`sharedGate`: what the connection returns is shown to people who could not see it) is unchanged,
   so nothing private reaches others without the asker's card. Names with invisible or non-ASCII letters stay changes.
2. **Noun-reads keep the "can't tell" card, and its Always is for good.** `get_post`, `list_pull_requests`: the card
   stays (a change word is in the name), with [허용] [항상 허용] [안 함]. 항상 허용 is kept per person, per connection
   and per tool, in every chat, until the person deletes it in Settings › Allowed for Trina (Claude Code's "don't ask
   again" is per tool too). It holds while the connection points at the same address (a re-pointed connection asks
   again, as `integration_user_allow` does), while the tool is still marked read-only (a changed mark makes it a change
   and the write card asks), while the team's "Always allow" switch is on (`teamAllowsAlways`), and only for the person
   themselves (their turn; in a scheduled run only when no other person's words steer it, `steerableRun`, as
   `alwaysHere`). The old per-chat rows (`shared_unsure_tool`) are still read; none are written.
3. **Plain words.** The card says what happens: "Bright Data로 이 페이지를 읽어요 · example.com/…" when the call names a
   web address, else "Bright Data에서 읽어 와요: Get post". Buttons 허용 / 항상 허용 / 안 함, one note line under them
   saying where to undo it. No "Trina can't tell" sentence.
4. **Settings.** Settings › Allowed for Trina lists each tool ("Bright Data · Get post", "항상 허용 · date") with
   Delete; deleting asks again next time.

Out: the write card and its per-connection Always (unchanged; persistent already); the shared connection card (per
chat, by audience; it protects other people, not the asker); the connector page listing per-tool grants (Settings
lists them; one place is enough).

## Scope added on 2026-11-22 (the owner, three more cards; coordinator)

- Aside's shared chat card ("…5명에게 보여요", radios, 이 채팅에서 항상 허용): its Always is for good per person and
  connection (not with a guest), one press, no "Aside을(를)".
- Aside's Repl card (no Always in a shared chat, jargon, raw code): every connector card offers Always; a shared chat's
  change on the person's own connection or app offers it per tool; sending to others and team connections keep asking.
  Plain sentence; code, parameters and ids behind "자세히".
- One rule set for every connector kind (MCP, local app, Google apps, HTTP API), tests for at least three kinds.

## Steps

1. Migration `441_b_connector_tool_allow.sql`: `connector_tool_allow(user_id, integration_id, tool, url, created_at,
   PK(user_id, integration_id, tool))`, both FKs ON DELETE CASCADE. Account removal and admin disable/delete clear it
   like `integration_user_allow`.
2. read-mark.ts: readKind as in Scope 1.
3. tools.ts unsureGate: persistent grant check and write; new words in text.ts (six languages).
4. API: `ConnectorToolAllowance` in the AiAllowance union (id `tool:<integrationId>:<tool>`), list and delete in
   `chat/always-allow.ts` (or a sibling), web AiAllowances row; i18n only if a new label is needed.
5. Tests (below), decision file, changes/ note.

## Decisions

`docs/decisions/20261122-connector-always-allow.md`. Narrows 20261118-shared-readonly-tools.md (unknown verbs are reads;
the "can't tell" card's Always is for good).

## Risks

- Security: a service that marks a sending tool read-only and names it with no change word ("beam_text") runs with no
  card in a shared chat. Same as in the person's own chat today; the service is one the person or team chose; Rule A
  (owner): no teammate-injection guards on top. Tools with any change word keep their card.
- Migration number: 441 (dev's highest b is 440; no open PR adds a migration on 2026-11-22 14:00 UTC).
- Safe-ops / account-removal guard lists the new user_id column.

## Tests

- `tests/unit/b-connector-tool-always.test.ts`: 항상 허용 in chat A → no card in chat B (another shared chat); delete
  in Settings (API) → the card again; another person still gets the card; a re-pointed connection asks again; team
  switch off → card with no Always; scrape_as_markdown in a shared chat → no card; a change-word tool still asks on the
  write card with no Always.
- Update `b-shared-readonly-tools.test.ts` and `b-shared-readonly-calltool.test.ts` for the new kinds and words.
- Web unit for the allowance row if the AiAllowances test exists.

## Result

Built as planned, widened the same day to one rule set for every connector card (see the decision file). Plan review:
export/download/check keep a card, recipients in a schema keep asking, access loss prunes the grant, alwaysHere's places
mirrored. Code review (2 rounds): no Always for HTTP requests or non-ASCII names, recipients in a call (nested too) keep
asking, Always bound to address and account, the AI's title said as the AI's. Real check on a private QA copy with
claude-code: all five scenarios passed (Always in chat A → no card in chat B; Settings removes it).
