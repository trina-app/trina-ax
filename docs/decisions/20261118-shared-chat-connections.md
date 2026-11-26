# Connected services in shared chats: the team's, and the asker's own behind a card

- Date: 2026-11-18
- Status: accepted (its team-file refusal is superseded by [20261126-shared-chat-own-tools.md](20261126-shared-chat-own-tools.md))
- Supersedes: "connected services (and connecting one)" in the list of what a shared chat does not offer
  ([Shared project chats](../DECISIONS.md), `rooms/ai-tools.ts` SHARED_TOOLS, `chat/prompt.ts` sharedSection and
  SHARED_PROMPT_SECTIONS `connected`)
- Branch: feat/shared-chat-connections (the owner, 2026-11-18, QA TC-4885 and TC-4886)

- **Ask:** in a shared project chat the owner asked "can you use Bright Data?" and the AI said no: the team had
  connected Bright Data for everyone, but connected services were off in every shared chat. The owner: a team
  connection everyone already has should just work there (TC-4885), and "shouldn't it work with my permission?" for
  the person's own connections (TC-4886).
- **Rule, which connections:** a shared chat's turn builds the connections of the person whose turn it is
  (`integrations/connections/tools.ts` in its shared mode, `BuildCtx.shared`, from `chat/tools.ts`): their own and the
  team's they may use, as in their own chat. Another person's connection is never built or run: bob's turn in alice's
  chat has bob's connections only. Slack reading stays off. A guest's own turn still has no connection at all.
- **Rule, when the card comes:** before a call fetches anything, the people who see the chat now and could not see what
  the connection returns make a card come first (`chat/turn.ts` confirmSharedConnection, `missingReaders` on the
  answer's sources, the same sources the chat's read scope gets): a person's own connection is theirs alone, so it
  always asks; a team connection asks only when its rule leaves out someone who sees the chat. So a team connection for
  everyone runs with no card. The card goes to the person of the turn only, like every card of a shared chat: "The AI
  wants to use <service>. This will show what <service> returns to the N people in this chat." Allow once (the rest of
  this answer), Always in this chat (`chat_card_approvals` kind `shared_connection`, with who saw the chat then: a
  person who joins later makes it ask again; 12 hours and cleared with the chat's session like the other card
  approvals), Cancel. Cancel, no answer in time, a scheduled run or a check that fails: nothing is fetched, and the AI
  is told why and that the person can ask in a chat only they see. Parallel calls of one connection share one card,
  which keeps the people it named: a call whose audience grew meanwhile asks again, and only people a card named are
  recorded. "Always in this chat" is kept for the connection as it is (its version and a hash of its account), so a
  reconnect, another account or a changed rule asks again. No one found to see the chat counts as a failed check
  (nothing is fetched). When a guest is among the people, the card says so: "…including a guest (someone outside the
  team)".
- **Rule, changes at the service (security review of #1276):** in a shared chat every call that changes something at
  the service asks the person on its own card naming the action, every time: the connection's rule or the person's
  own Always allow, the explicit-ask skip and an earlier yes in the chat do not apply, and that card offers no Always
  allow there. Other people's messages are in the transcript and could steer the AI; the shared card ("shows what it
  returns") never covers a change. Team files (`team-file:` handles) are not sent to a service from a shared chat at
  all: refused before any card, the person sends them from a chat only they see.
- **Rule, guests:** while a guest sees the chat (a guest's own chat in their project, a chat shared with people that
  names a guest) the team's connections are not offered or run, because guests have connectors off; the list in the
  instructions names them and says why, so the AI says so plainly. The asker's own connection stays, behind its card,
  which counts the guest among the people it names (like a file read card).
- **Rule, the answer's record:** what the call brings in joins the answer's read record before the call
  (`chat/shared-answers.ts`; a record that cannot be written is a refusal), in a group with a new mark `k`: an answer
  from the cutover on is hidden from anyone not in that group who may not read every place in it now. So someone who
  joins later and may not use that connection (anyone but its owner for a person's own; outside the rule for a team
  one) gets one line in its place; someone the team connection covers sees it. An older build ignores `k` and shows the
  answer, as the cutover rule says.
- **Rule, secrets:** unchanged: every answer leaves through `hiding` (the stored secrets of the connections a call used),
  the arguments through `hideKeys`, and the chat view never shows a stored connection secret (`routes/chats.ts`).
- **Not here:** connecting a new service from a shared chat (`connect_service` is not offered; the instructions say to
  connect in Settings › Connectors or in a chat only they see), and the connect card for a connection that needs a new
  sign-in.
- **Tests:** `tests/unit/b-shared-chat-connections.test.ts` (a team connection with no card and its record; the guest
  case; the card to the asker only, its words and options, nothing fetched before the answer, Cancel, no answer, Allow
  once, Always in this chat and a new person; bob's turn never runs alice's connection; the key never in what bob
  sees; a later joiner does not see the answer; the provider's lines and the instructions; `lateHides` with `k`; a change
  with the person's Always allow and Always in this chat still asks; a team file refused; a parallel call whose
  audience grew; no audience; the guest line on the card; a reconnected connection asks again).
- **Version impact:** minor (shared chats offer connected services).
