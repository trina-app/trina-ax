# Fewer cards for connected services in a chat that read a room

- Date (UTC): 2026-11-09 19:28
- Branch: `feat/room-read-connection-cards`
- Status: done
- Where: trina-ax core (`server/src/chat/`, `server/src/integrations/connections/tools.ts`, `server/src/services.ts`,
  `server/src/tools/url-gate.ts`). Why: the chat's tool gate and the connections are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. Fewer confirmation cards in one kind of chat; one optional field on the connect_service card
  (`lead`), no setting or data change.

## Goal

The owner, on the ✦ side chat and a chat that has read a room: the cards come far too often ("허용 계속 눌러주는게
지치겠다"). Once a chat has read a room (`chats.rooms_seen`, docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기"), every call
of a connected service (Notion, Gmail, …) raises the room card, reads included, and a write raises two cards: the room
card, then the connection's own card. Drive's reads already go on without a card there.

After this change, in the person's own chat (the ✦ side chat included) after a room read:

- a connection's **read** goes on with no card, like Drive's reads, unless its arguments carry a web address or a long
  random-looking part (then the room card, as today);
- a connection's **write** is one card: the connection's card (everything it sends, where it goes first), with the room
  line on top ("여기에 대화방 메시지(다른 사람이 쓴 글)가 들어와서, 무언가를 바꾸기 전에 먼저 물어봐요."). A team connection
  set to send without asking asks here too. A connection set to refuse still refuses.
- Added during the work (the card-fatigue audit, change 3): the other tools with a card of their own do the same, one
  card instead of the room card and then theirs: `schedule_create`, `generate_video`, `move_files` and `copy_files`
  (asking also when nobody's access changes), `move_skill`, `connect_service`.

## Scope

In:
- `TurnTool.readOnly?: boolean | ((args) => boolean)` (server/src/services.ts), set by the connections' tools: an MCP
  tool the service marks read-only (the saved `readOnly`), `api_request` with GET or HEAD, `call_tool` whose indexed
  target is read-only, `find_tools` always.
- chat/tools.ts keeps it for the integrations provider's tools only (a tool of any other provider, or one that does not
  say, is no connection tool: it keeps the room card) and exposes `readsOnly(name, args)`; `exec.readsOnly`.
- chat/turn.ts `confirmRoomChange`, own chat after a room read, a person there to answer (`ownCard`): a connection's
  read whose arguments carry no address (`extractUrls`, also %-decoded, or an address without `https://`) and no
  random-looking part (`opaqueParts`) goes on; a connection's write and the tools in `ROOMS_SEEN_OWN_CARD_TOOLS` raise no
  room card. Their person (chat/tools.ts `roomLinePerson`) puts the room line on every card, adds the room card's details
  to a card that has none, and says `TurnPerson.roomsSeen`, so the tool asks every time: the connection's `gate()` treats
  "send without asking" as "ask", a move asks without an audience change. `move_skill` and `connect_service` (not
  registered tools) add the line themselves; the connect card shows it in a new optional `lead`.
- Tests: b-chat-rooms.test.ts with a real connection (fake service), c-integrations-tools.test.ts for the gate,
  move-skill.test.ts, the web connect-card test.
- DECISIONS ("내 AI 채팅에서 대화방 읽기"), INTEGRATIONS.md, CHANGELOG.

Out:
- A room's own "@트리나" session (part B of the plan; connections stay out of it).
- Shared project chats, confidential chats and scheduled runs: unchanged (no connection tools in the first three; a
  scheduled run in a chat that read a room still asks nobody and changes nothing).
- Exempting addresses the service itself returned in this chat (a Notion page's own link): later, if the cards for
  those are still too many.

## Steps

1. `readOnly` on `TurnTool` and the four kinds of connection tools; kept for the integrations provider in chat/tools.ts.
2. The address and random-part check for a read's arguments (tools/url-gate.ts).
3. `confirmRoomChange`: the read without a card, the write without the room card; `roomsSeen` on the tool context.
4. `gate()`: no "send without asking" when `roomsSeen`; an MCP tool that was a write when the turn began still asks.
5. The other tools with their own card: the person with the room line, a move without an audience change asks,
   `move_skill`'s question and `connect_service`'s `lead`.
6. Tests, docs, changelog.

## Risks

- **A room message makes the AI read and send data out through a read.** A read whose arguments hold an address or a
  long random-looking part asks first. Plain words in a search go to the connected service, which the team or the
  person connected (the same as the engine's web search and Drive search after a room read; accepted in the plan).
- **A service marks a write read-only, or an HTTP API changes something on a GET.** The mark is the service's own
  (connections/mcp.ts), the method the AI's; a clean chat trusts both already, and whoever manages the connection can
  turn the tool off. Accepted in the plan (GET and HEAD are reads); a card for a GET whose query names a recipient was
  tried in review and dropped (exact names only, and cards on plain reads such as `?channel=`).
- **Fail closed.** Only the integrations provider's tools count; a tool there that does not say keeps the room card.
- **A tool on the own-card list acts without asking.** Each listed tool asks before any effect whenever
  `TurnPerson.roomsSeen` is set (checked for each: the schedule, video, move and skill cards are unconditional or made
  so, the connect form is the only way to connect); a tool added to the list must do the same.
- No migration. No new words (the room line is `roomsSeenWhy`, in five languages); old web apps ignore `lead`.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; b-chat-rooms, the chat, room and integrations suites, the
security permission matrix, the whole tests/unit suite compared with dev, the web unit tests.

## Result

Built as planned, plus the card-fatigue audit's change 3 (the other tools with their own card) and the fixes from an
independent review before the PR: `carriesAddress` reads `call_tool`'s JSON-text arguments as the tool takes them and
catches `https:/…`, `https:host`, full-width hosts and a whole host value; the own-card skip runs after the
instruction-file rule, so a copy of a planted `CLAUDE.md` is still refused. Cards after a room read: a Notion read 1 → 0,
a Notion write 2 → 1, a read with an address 1 → 1. PR: https://github.com/trina-app/trina-ax/pull/274
