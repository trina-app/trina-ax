# Always allow holds everywhere: sites for good, shares and posts in shared chats, @everyone, shared-chat runs, dev logins

- Date (UTC): 2026-11-22 14:54
- Branch: `fix/always-allow-holds-everywhere` (on top of `fix/connector-always-allow`, which handles B1, B2 and M1)
- Status: in progress
- Where: server (chat cards, url gate, dev environment), shared API, web Settings. Why: the owner, 2026-11-22: "이렇게
  또 권한을 매번 대화마다 다 해줘야하는 미친 상황 더 없겠지?" Rule A (docs/decisions/20261116-always-allow-final-rule-a.md)
  already decides it: Always allow is final everywhere.
- Version impact: patch (fewer cards and a remembered choice; one additive table, reader 1).

## Goal

Every "Always allow" a person gives holds in every chat and in their own scheduled runs, and every one is listed in
Settings › 트리나에게 허용한 것, where removing it brings the card back. The permission audit of origin/dev 834f98f found
five places where it does not.

## Scope

In:
- **B3** web address card: "이 대화에서 이 사이트 허용" becomes "이 사이트 항상 허용 ({site})", kept per person in a new
  table `user_allowed_sites` (migration 442), counted in every chat the person asks in and in their scheduled runs (not
  in a confidential chat; the hard limits stay: marked parts, user info, echoes, private addresses). A shared chat where
  a guest is among the people keeps the old per-chat row (the B1 rule of fix/connector-always-allow). Settings lists
  these sites and the in-app browser's office-network sites ("항상 허용" on `browser_site`, table
  `browser_site_grants`, today never listed), each removable. The old per-chat rows keep counting where they are.
- **B4** share_with_person, post_to_room, share_folder: remove the per-call `alwaysOk` override (in a shared chat or a
  chat others wrote in, the person's Always counted only when their own message named every recipient). Keep only the
  first ask. With Always on, the "file / folder / recipient must be named by the asker" refusals no longer apply in a
  shared chat either (they already did not in a chat that only read others' content). The dead "card although Always"
  line (othersWordsCard, OTHERS_WORDS_RULE) goes. share_folder adds (not stops) run in a scheduled run under Always.
- **B5** post_to_room with @everyone: remove `!mentionAll` from the Always place. The "@everyone only when the
  person's own message wrote it" refusal and the everyone-room owner/admin rule stay (they are not cards).
- **B6** scheduled run in a shared chat whose branch holds another person's words (`steerableRun`): the maker's Always
  rows all hold (chat/always-allow.ts alwaysHere, the connector Always in integrations/connections/tools.ts
  alwaysPlaceOf, the shared connection card in chat/turn.ts sharedConnMayKeep), and a change at a connected service is
  no longer refused outright: it goes through the usual scheduled-run rules (team "send without asking" + the task's
  card). The write-folder limit of such runs (steerableWriteRefusal) is not an Always and stays.
- **M2** dev environment: a command that can use a login after teammates changed files: the card gains "항상 허용"
  (kind `dev_login` in `card_always_allow`), per person, listed and removable in Settings like every card kind; under it
  the command runs and the changes are still listed in the result.

Out: other kinds of cards, the 12 h per-chat approvals, Allow all websites (already in Settings › Browser), dev env sites
(already in Settings › Dev environment).

## Steps

1. Migration 442 `user_allowed_sites (user_id, site, created_at)`; url-gate.ts: allowedSites = the person's own sites
   ∪ the chat's rows, siteScope no longer needs the chat to be theirs (any chat they ask in, not confidential);
   the card's option and line say "always"; `TurnPerson.guestHere` → a guest present keeps the per-chat row.
2. tools/site-allow.ts (new, small): list / drop the person's web sites and office-network sites for Settings.
3. shared api: `SiteAllowance` (kind `site`, `place: 'web' | 'office'`), CardAlwaysKind += `dev_login`; routes;
   web AiAllowances row; i18n in six languages (en, ko, id, ja, es, zh); docs:api.
4. B4/B5: share-with-person.ts, post-to-room.ts, share-folder.ts, share-words.ts, prompt.ts, shared-actions.ts.
5. B6: always-allow.ts, connections/tools.ts, turn.ts.
6. M2: devenv/tool.ts (confirm with `always: 'dev_login'`), chat/tools.ts host, ALWAYS_WHAT.
7. Tests (below), decision file, changes file.

## Decisions

New: docs/decisions/20261122-always-allow-holds-everywhere.md (Rule A; each removed guard; the one limit kept: a
guest in a shared chat keeps per-chat scope). Updates the site rule of docs/DECISIONS.md "allow this site in this
conversation" and 20261116-always-allow-more-cards.md "Content written by others".

## Risks

- Migration number: 441 is the highest (fix/connector-always-allow); 442 checked against dev and open branches.
- Security: a teammate's message in a shared chat can now steer an Always'd share, post or folder share, and a shared
  chat's scheduled run uses the maker's Always. The owner chose this (Rule A, teammates trusted). Hard limits stay:
  data-like address parts, echoes, private addresses, confidential chats, the team switch, guests' per-chat scope.
- Six app languages for the new labels.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`. Per item: allow once → no card
in a new chat and in a scheduled run; remove in Settings (DELETE /api/ai-allowances/:id) → the card again. New file
`tests/unit/b-always-holds-everywhere.test.ts`; updated: site-allow, b-shared-chat-schedules, the share / post tests that
asserted the old guard, web AiAllowances test.

## Result

(at the end)
