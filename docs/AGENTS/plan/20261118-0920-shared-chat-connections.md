# Connected services in shared chats: team connections, and the asker's own behind a card

- Date (UTC): 2026-11-18
- Branch: `feat/shared-chat-connections`
- Status: in progress
- Where: server (chat turn, connection tools, shared answers) and shared i18n. Why: the chat turn and the connection
  tools are Team AX core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, shared chats offer connected services they did not offer before

## Goal

In a shared chat (a team project chat, or a chat shared with people) the AI never offered connected services, so "can
you use Bright Data?" got a no even though the team connected it for everyone. Owner decisions 2026-11-18 (QA TC-4885,
TC-4886):

- a team connection everyone in the chat may already use works with no extra card; not when a guest is in the chat
  (guests have connectors off), and the AI then says so plainly;
- the asker's own connection works too, behind a card only the asker sees before anything is fetched: Allow once /
  Always in this chat / Cancel. Cancel or no answer fetches nothing. Another member's turn uses their own connection.

## Scope

In: the integrations tool provider is built in shared chats (shared mode), the card before a call, the answer's read
record, the shared-chat prompt, copy in every locale, a decision file and a changes note, tests.
Out: connecting a new service from a shared chat (stays off: Settings › Connectors or a private chat); Slack reading.

## Steps

1. `chat/tools.ts`: build the integrations provider in a shared chat (not for a guest asker, a confidential or
   restricted run), let its tools past the shared allowlist, keep the file read card off for them.
2. `integrations/connections/tools.ts`: shared mode (`BuildCtx.shared`): no team connection while a guest is in the
   chat, no connect_service lines, a line per connection that says whether a card comes first; every call asks
   `shared.confirm` before anything is fetched; `turnChat` accepts a shared chat's turn of another person.
3. `chat/turn.ts` `confirmSharedConnection`: the people who cannot see what the connection returns (missingReaders on
   the answer's sources); none: recorded, no card; else the card (once / always in this chat / cancel), the yes kept in
   `chat_card_approvals` (kind `shared_connection`, with who saw the chat), recorded with a `k` group.
4. `chat/shared-answers.ts`: a `k` group hides a late answer from anyone not in it who may not read every place now.
5. Prompt (`chat/prompt.ts`), i18n (`shared/src/i18n`), docs.

## Decisions

docs/decisions/20261118-shared-chat-connections.md. Changes the "connected services" line of
[Shared project chats](../../DECISIONS.md) and the list in `rooms/ai-tools.ts` SHARED_TOOLS.

## Risks

Permissions: another person's connection must never run, the stored secret never reaches the chat view; a later
joiner must not see an answer built on a personal connection. No migration (chat_card_approvals.kind is free text).

## Tests

`bun run typecheck`, `bun run check:prepush`, unit tests of the shared chat area (new
`tests/unit/shared-chat-connections.test.ts`), screenshots of the card at 1440 light and 390 dark.

## Result

(filled in at the end)
