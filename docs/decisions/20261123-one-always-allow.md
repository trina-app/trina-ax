# One "Always allow": no Always for one chat, and "<connector> 전체 항상 허용"

- Date: 2026-11-23
- Status: accepted
- Supersedes: the guest limit of [20261122-connector-always-allow.md](20261122-connector-always-allow.md) ("Always in this
  chat" with a guest among the people, #404) and of [20261122-always-allow-holds-everywhere.md](20261122-always-allow-holds-everywhere.md)
  (B3's per-chat site, the guest exceptions of B6 and of a watched turn, #403/#413, and #412's late-Always guest guard)
- Branch: fix/one-always-allow

- **Ask:** the owner, 2026-11-23: "그 대화에서만 항상 허용이 아니라 그냥 전체 항상 허용이 있어야할 것 같은데. 대화에서만
  항상허용을 따로두기도 좀 그렇고". Then, for the same change: on the first connector card also offer "<connector> 전체 항상
  허용", "질문수도 줄어야해". Rule A ([20261116-always-allow-final-rule-a.md](20261116-always-allow-final-rule-a.md)) already
  said Always is final everywhere; this removes the last scope that was not.
- **Rule, one Always:** every card that offers Always offers [허용] [항상 허용] [안 함]. "항상 허용" is the person's own, for
  good: every chat they ask in (their own, a shared chat, a side chat, a shared chat with a guest among the people), their
  own scheduled runs (also one another person's words steer, a guest among the people too), until they remove it in
  Settings › 트리나에게 허용한 것 or an admin turns the team's "Always allow" switch off. No card offers, keeps or reads an
  Always for one chat: `chat/always-allow.ts` (no `chatScoped`, `ALWAYS_CHAT_VALUE`), the shared connection card
  (`chat/turn.ts`, no `always_chat`), the connector cards (`connections/tools.ts`, no `chat` option), the address card
  (`tools/url-gate.ts`, "이 사이트 항상 허용" only). Where an Always cannot be kept (the team's switch off, a Slack question,
  a confidential chat, a draft, a demo server) the card offers no Always at all, as every other card already did.
- **Rule, "<connector> 전체 항상 허용":** the read card and the own-things card of a connected service (`cardWithAlways`)
  and the shared connection card offer four buttons: [허용] [항상 허용] [<connector> 전체 항상 허용] [안 함] (one row on a
  computer, stacked on a phone; the line under them says what each covers, at most 300 characters, the tool's line alone
  when both do not fit). Kept: one row per person and connection (`connector_tool_allow`, tool `ALL_TOOLS`, a name with a
  NUL that no MCP tool has), bound to the connection's address and account (`sharedBind`; tools the service adds later are
  covered too), ended when the address or account changes, when the team connection's rule no longer includes the person
  (`pruneMemberAllows`), when the account is disabled or removed, and ignored while the team's switch is off. It counts
  wherever a tool's own Always counts: a read card (`unsureGate`), a call that acts only on the person's own connection's
  things (`sharedAlwaysKey`, in a shared chat, their own chats and their scheduled runs), and the shared connection card
  (what the connection returns shows to the people of a shared chat). It is never a write rule (`memberAllows`, the
  connection's "send without asking"): a call that reaches other people, a change at a team connection's service in a
  shared chat, an HTTP API request and any call with team files ask every time, as before. Settings lists it as one entry
  ("Aside · 모든 도구"), removable. Merged choice: four buttons rather than three, because the owner asked to keep the
  per-tool Always; the four-button row is used only by these cards (the request's `row` flag; the folder access card with four choices stays the
  form it was).
- **What still asks each time (unchanged):** the share, room post and folder share checks of what the asker's own message
  named while a guest is among the people (`guestInShared`), a team connection's change in a shared chat, a team
  connection refused while a guest is there, a scheduled run with a guest and another person's words that would act
  without the maker's own Always (only their Always lets a change go there).
- **Stored rows:** migration 446 deletes the per-chat rows (`chat_card_approvals` kinds `shared_connection`,
  `shared_unsure_tool`, `shared_own_act`, `card_always`, which lasted 12 hours at most, and every `chat_allowed_sites`
  row). None becomes permanent, which would widen what the person chose; the next card offers "항상 허용". The person's
  permanent rows stay. A card raised before this version and answered with its old "Always in this chat" value reads as a
  no.
- **Risk taken:** a guest in a shared chat now sees what the person's own connection returns under the person's Always,
  and one press of "<connector> 전체 항상 허용" on a read card also lets the connection's answers show in shared chats. The
  person chose it on a card that says so; the owner rejects teammate and guest guards on top of Always (Rule A).
- **Tests:** `tests/unit/b-one-always-allow.test.ts` (no per-chat Always text anywhere; one press of "Bright Data 전체 항상
  허용", then another tool has no card in a new chat and in the scheduled run; Settings shows one entry, removing it asks
  again; moved connection, switch off, lost access; a change still asks; migration 446),
  `b-shared-chat-connections.test.ts` (a guest among the people: four buttons, Always holds there and from elsewhere),
  `b-always-holds-everywhere.test.ts` (no "Always in this chat" on any card, the old value is a no; the guest's site card
  is for good).
- **Version impact:** patch (fewer cards, one more remembered choice; a data-only migration).
