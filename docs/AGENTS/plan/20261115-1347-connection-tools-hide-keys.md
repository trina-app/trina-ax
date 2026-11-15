# What the AI sends to a connected service never holds a stored connection key

- Date (UTC): 2026-11-15 13:47
- Branch: `fix/connection-tools-hide-keys`
- Status: planned
- Where: server/src/integrations/connections/hide-args.ts, server/src/chat/tools.ts (the turn's tool set, the hook
  #971 added in mcp/protocol.ts), server/src/chat/turn.ts (the live answer at a tool call). Why: the calls to outside
  services are server work (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a security fix with no new feature or API change

## Goal

QA tracking TC-3081: the AI can put a person's stored connection key into a call to a connected service (an MCP tool,
Gmail, Drive, Notion, api_request). The confirm card shows the arguments with the key hidden, but the call sends the
real key: the person approves something other than what is sent, and the service gets the key.

## Scope

In:
- Every tool a connection provider adds to the turn (the connections' own tools, api_request, call_tool, Slack's read
  tools): every string in its arguments goes through the turn's redactor (redact.ts, the one the answer, the steps and
  the card use) in the one hook #971 added (TurnToolSet.hideKeys), before the room card, the connection's card and
  the call. So the card shows exactly what is sent, and the service gets [hidden key] where the AI wrote the key.
- A Gmail attachment's base64 `content` that would change: the send is refused (a changed attachment would be a broken
  file), and the AI is told why.
- The connection's own credentials are not arguments (headers and the sign-in layer: service.ts authHeaders, a team
  admin's query in the connection address) and keep working. Checked: no tool takes a stored key in its arguments.
- Two cheap points from the #971 review: write looks up the file it overwrites under the path it really writes (the
  hidden one); a tool call no longer lets out held answer text that could be the start of an encoded key (it waits for
  the next piece or the end, as between text pieces).

Out:
- TC-3082 (a start-up scan that reports AI-made files holding a stored key): its own PR (reads every AI-made file and
  its text cache, needs a notice to the owner); see the PR body.

## Steps

1. Plan (this commit).
2. hide-args.ts `hideAllArgs`, the hook in chat/tools.ts for provider tools; turn.ts tool_start; write's lookup path.
3. Unit tests that fail without the fix: a fake MCP connection and a fake HTTP API (tests/lib/fake-services.ts through
   net.ts testAllow), key `sk-RK1115-FAKE`: the card and what the service got hold [hidden key], auth still works.
4. DECISIONS entry, changes/ fragment.

## Risks

No migration, no UI text. Plain-words check: the only mark is the existing "[hidden key]". A person who asks the AI to
send their own stored key somewhere gets [hidden key] sent; that is the intent (the AI never sees stored keys).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit c-integrations-*, chat-*, mcp-*.
