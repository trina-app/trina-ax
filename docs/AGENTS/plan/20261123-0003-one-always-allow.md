# One "Always allow": no chat-scoped Always anywhere, plus "<connector> 전체 항상 허용"

- Date (UTC): 2026-11-23 00:03
- Branch: `fix/one-always-allow`
- Status: in progress
- Where: server (chat cards, connections, url-gate), shared (allowance type), web (Settings, ask card), docs. Why: the
  owner's decision of 2026-11-23 (docs/REPOSITORY-RULES.md: product rules live with the code that enforces them)
- Version impact: patch (fewer cards and one remembered choice; one data-only migration that drops per-chat rows)

## Goal

The owner, 2026-11-23: "그 대화에서만 항상 허용이 아니라 그냥 전체 항상 허용이 있어야할 것 같은데. 대화에서만 항상허용을 따로두기도
좀 그렇고". And, for the same PR: on the first connector card also offer "<connector> 전체 항상 허용" (every tool of that
connector, for good), "질문수도 줄어야해".

After this, a card offers [허용] [항상 허용] [안 함] (a connector card also [<connector> 전체 항상 허용]). "항상 허용" is
the person's own, for good, in every chat (shared chats with a guest too) and in their scheduled runs, and Settings ›
트리나에게 허용한 것 lists and removes it. No card says "이 대화에서 (항상) 허용" any more.

## Scope

In:
1. `server/src/chat/always-allow.ts`: remove `chatScoped`, `chatAlwaysOn`, `keepInChat`, `keepAlwaysAt`,
   `ALWAYS_CHAT_VALUE`, `AlwaysPlace.sharedGuest/audience`, the guest branches of `alwaysHere` (live and scheduled) and
   the guest line of `alwaysNote`. `withAlways` offers only `ALWAYS_VALUE`.
2. `server/src/chat/turn.ts`: the room-change card, `askAlways` (`onAlways` without the chat flag), the wider-save card,
   the shared connection card (`sharedConnMayKeep` without the guest check; no `always_chat` value; no per-chat
   `shared_connection` approval rows read or written; where Always cannot be kept the card offers Allow / Don't allow
   only), and the late-Always keep in `replayCalls` (no `!this.guestAmong()`).
3. `server/src/integrations/connections/tools.ts`: `alwaysPlaceOf` without the guest check; remove
   `chatAlwaysPlaceOf`, `chatAllowed`, `chatAlwaysKind` and the "chat" option; drop the scheduled + guest + steerable
   refusal in `gate` (the maker's Always holds there as in any of their runs).
4. `server/src/tools/url-gate.ts` + `chat/tools.ts` TurnPerson: the site option is "이 사이트 항상 허용" for good only;
   `chat_allowed_sites` is no longer read or written; where it cannot be kept for good (team switch off) the site
   option is not offered (as every other card with the switch off). `sitesForGood` and `scheduledRun` lose the guest
   condition.
5. `server/src/chat/card-approvals.ts`: drop the kinds `card_always`, `shared_unsure_tool`, `shared_own_act`,
   `shared_connection`.
6. Migration 445 (data only): delete those `chat_card_approvals` rows and every `chat_allowed_sites` row. Permanent rows
   (`card_always_allow`, `connector_tool_allow`, `user_allowed_sites`, `browser_site_grants`, `integration_user_allow`)
   are not touched. The table `chat_allowed_sites` stays (an older reader may read it); a chat-scoped yes is not turned
   into a permanent one (that would widen a choice the person never made).
7. Connector-wide Always (owner's addition): one row per person and connection in `connector_tool_allow` with a
   reserved tool name (`ALL_TOOLS`, not a possible MCP tool name), bound like the others (`sharedBind`: address +
   account), pruned like the others (`pruneMemberAllows`, account disable/removal) and ignored with the team switch off.
   It counts wherever a per-tool row counts (the read card `unsureGate`, the shared-chat own-things card in `gate`), for
   the shared connection card (`sharedAllowed`), and as the person's own write allowance for that connection in their
   own chats and scheduled runs (as `memberAllows` / their own connection's rule). Writes through a team connection in
   a shared chat still ask every time (`sharedAlwaysKey` is null for them, unchanged). Offered on `cardWithAlways` and
   on the shared connection card: four buttons [허용] [항상 허용] [<connector> 전체 항상 허용] [안 함]; the web ask card
   shows four server buttons in one row (stacked on a phone). Settings lists it as one entry per connector
   ("Aside · 모든 도구"), removable.
8. i18n: remove the chat-scope strings (server `chat/i18n.ts`, `connections/text.ts`, `url-gate.ts` TEXT), add the
   connector-wide label and note in 6 languages, web `allowances.connectorAll` in 6 languages.
9. Docs: update `20261122-always-allow-holds-everywhere.md` and `20261122-connector-always-allow.md` (the guest limit is
   superseded), new `docs/decisions/20261123-one-always-allow.md`, `changes/one-always-allow.md`.
10. Tests: no chat-scope button anywhere (a source scan + card tests); one Always holds in a new chat, in a scheduled
    run, and with a guest present; revoke brings the card back; connector-wide: one press, then another tool of the
    same connector has no card in a new chat and in a scheduled run, revoke brings it back, address change / team
    access lost / team switch off end it. Update existing tests that expected the chat scope.

Out (unchanged, still ask every time): the share recipient checks (`guestInShared` strict naming checks in
share/post/folder), team-connection writes in shared chats, a team connection refused with a guest present, the
private-chat write card (its Always is already connection-wide), confidential chats, Slack questions, demo servers.

## Steps

1. This plan; independent plan review.
2. Server scope removal (1–6), then connector-wide (7), then i18n/web (8), docs (9), tests (10).
3. Gate on the Mac mini: typecheck, check:prepush, area unit tests, web tests (one at a time).
4. Real check on a private QA copy with claude-code: count the asks for an Aside-like and a Bright Data-like flow
   before (origin/dev) and after.
5. Independent code review; PR into dev with "reviews done", not enqueued.

## Decisions

New: `docs/decisions/20261123-one-always-allow.md`. Changes: the guest limit of
`20261122-connector-always-allow.md` and `20261122-always-allow-holds-everywhere.md` (B3 per-chat sites, the guest
fallback of #404/#403/#413, #412's late-Always guest guard).

## Risks

- Migration number: 444 is the highest on dev; 445 here. Re-check before the PR.
- A guest in a shared chat now sees results of a person's connection under that person's own Always (Rule A, owner).
- Overlap with batch-5 PRs on turn.ts, connections/tools.ts, AskCard and i18n: keep the diff to scope removal.

## Tests

`bun run typecheck`, `bun run check:prepush`, the always-allow / connector / shared-chat / site unit tests, web tests.

## Result

(at the end)
