# Always allow holds everywhere: sites for good, shares and posts in shared chats, @everyone, shared-chat runs, dev logins

- Date: 2026-11-22
- Status: accepted
- Supersedes: "allow this site in this conversation" of [Allow a site for one conversation](../DECISIONS.md#allow-a-site-for-one-conversation-featexfil-followups-2026-10-30) (now for
  good, except with a guest); "Content written by others" of [20261116-always-allow-more-cards.md](20261116-always-allow-more-cards.md)
  for shares and posts in a shared chat; H1 and H2 of the security review of #1353 in
  [20261118-shared-schedules-any-frequency.md](20261118-shared-schedules-any-frequency.md) (the maker's standing yeses in
  a run a teammate's words are in)
- Branch: fix/always-allow-holds-everywhere (on fix/connector-always-allow, which did B1, B2 and M1 of the same audit)

- **Ask:** the owner, 2026-11-22: "이렇게 또 권한을 매번 대화마다 다 해줘야하는 미친 상황 더 없겠지?" A permission audit
  (origin/dev 834f98f) found five places where a person's "Always allow" did not hold. Rule A
  ([20261116-always-allow-final-rule-a.md](20261116-always-allow-final-rule-a.md)) already decides them: Always allow is
  final everywhere (rooms, shared chats, side chats, the person's own scheduled runs, after reading other people's
  words), with no caps and no teammate-injection guards on top. Nothing here goes back to the owner.
- **Removed guards:**
  - **B3** `tools/url-gate.ts`: "이 대화에서 이 사이트 허용" kept a site for one chat of its owner only (`siteScope`
    required the chat to be theirs). Now "이 사이트 항상 허용 ({site})" keeps it for the person for good (migration 442
    `user_allowed_sites`) and counts in every chat they ask in (a shared chat, a side chat too) and in their scheduled
    runs; the person's own scheduled run also gets their "Allow all websites" (①d; `TurnPerson.scheduledRun`). The
    address limits stay (below).
  - **B4** `chat/share-with-person.ts`, `chat/post-to-room.ts`, `chat/share-folder.ts`: in a shared chat the Always
    counted only when the asker's own message asked and named every recipient (`alwaysOk`, QA TC-3091, added because
    another member's message is in the AI's context), and the "file / folder / recipient must be named by the asker"
    refusals held under Always in a chat with other members' messages. Both go: once on, the choice is final there. The
    first card is the only ask. The prompt line telling the AI a card may come back under Always after content by others
    (`OTHERS_WORDS_RULE`, `othersWordsCard`, `othersWordsWhy`) goes with it. share_folder adds now run in the person's
    scheduled run under their Always (`actionOff(exec, 'share_folder')`); a stop or a removal there is refused (it has no
    Always). A post with files is offered in a scheduled run under the `post_files` Always as well.
  - **B5** `chat/post-to-room.ts`: a post that mentions everyone always showed its card and offered no Always
    (`!mentionAll`). Now the person's Always covers it. "@everyone" still goes only when the person's own message wrote
    it, and in the room for everyone only for an owner or admin (not cards: they decide what may be asked at all).
  - **B6** `chat/always-allow.ts alwaysHere`, `integrations/connections/tools.ts gate` and `alwaysPlaceOf`,
    `chat/turn.ts sharedConnMayKeep`: a scheduled run in a shared chat whose branch held another person's words
    (`steerableRun`) got none of the maker's standing yeses, never the shared read card's, and no change at any connected
    service (security review of #1353, H1/H2). Now the maker's Always rows hold there, and a change goes by the usual
    scheduled-run rules (the team's "send without asking" with the task's card, the maker's own Always).
  - **M2** `devenv/tool.ts askLoginAfterOthers`: a command that can use a login after teammates changed files had only
    "Run it / Do not run". The card now offers "항상 허용" (card kind `dev_login`), per person, listed and removable in
    Settings; under it the command runs, a sub-agent's too, and the result still lists the changes by others and says no
    card was shown (`RAN_UNDER_ALWAYS`).
- **Visible and revocable:** every Always is in Settings › Allowed for Trina (GET / DELETE /api/ai-allowances): the
  card kinds (`dev_login` added), the connector tools, and now the sites (`kind: 'site'`, `place: 'web'` for
  `user_allowed_sites`, `'office'` for the in-app browser's office-network "항상 허용", `browser_site_grants`, which was
  kept for good before but listed nowhere). The list is sorted newest first across kinds. Dev environment sites stay in
  Settings › Dev environment, "Allow all websites" in Settings › Browser.
- **The one limit kept:** a guest (someone outside the team) among the people of a shared chat keeps the per-chat
  scope, as [20261122-connector-always-allow.md](20261122-connector-always-allow.md) decided for the shared connection
  card. There a site choice is "이 대화에서 이 사이트 허용" (kept per chat, and the card says so); share, post and folder
  share keep the old own-ask guards; a scheduled run with another person's words on its branch gets none of the maker's
  standing yeses and sends nothing to a connected service (`TurnExec.guestAmong`: the person, the people of the shared
  chat, the members of a side chat's room; fails closed). For sites a room side chat with a guest counts too.
- **Not Always, unchanged (hard limits Rule A keeps):** the caller's own choice only, never another member's; the
  team's "Always allow" switch (off: rows ignored, the site card offers this chat only); confidential chats, Slack
  questions and drafts; on addresses: long random-looking parts, a long name before the site, a user name or password,
  an echo of what the AI sent, a long query in a run nobody watches, an unknown exit address, private and office-network
  answers after the lookup; the write folder of a scheduled run a teammate's words are in (`steerableWriteRefusal`,
  not an Always: such a run writes only in its task's save folder or the maker's own folder).
- **Risk taken:** in a shared chat a teammate's message can now steer a share, a post or a folder share the person
  allowed for good, and a shared chat's scheduled run uses the maker's Always. The owner treats teammates as trusted
  (Rule A); the guest limit and the hard limits above stay.
- **Tests:** `tests/unit/b-always-holds-everywhere.test.ts` (each item: allow once, no card in a new chat and in the
  scheduled run, removed in Settings, the card again; the guest and team-switch cases), updated `site-allow.test.ts`,
  `b-others-words-gates.test.ts`, `b-shared-chat-schedules.test.ts`, `b-ai-share-words.test.ts`,
  `b-ai-share-integration.test.ts`, web `ai-allowances` test.
- **Version impact:** patch (fewer cards and remembered choices; one additive table, reader 1).
