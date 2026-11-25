# Connected apps: their own guide reaches the AI, and the right account is picked first

- Date (UTC): 2026-11-25 01:02
- Branch: `fix/aside-profile-choice`
- Status: in progress
- Where: server (component C, connections), desktop (local apps), shared. Why: the AI used a browser connection in
  the wrong account although the right one was listed (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new saved field per connection (migration, additive) and new AI behaviour for every MCP
  connection; no API break.

## Goal

A person asked the AI to answer a mail in one of their mailboxes ("the company's mail at service X"). With the Aside
connection the AI (1) sent the account words as free text to Aside's own agent, which failed with "sign in again",
(2) opened the browser without choosing a profile, searched the default profile's mailbox (another account), found
nothing and stopped, (3) listed the 14 profiles only when the person asked. The same person's Claude Code finds the
right profile at once.

Root causes (all general, none is about one mailbox or one service):

1. **The app's own usage guide never reaches the AI.** Claude Code reads Aside's guide (`aside guide`, through its
   skill) before it starts: use the agent for most tasks, look in Aside's memory for the person's context first, list
   profiles and pass a profile id. Trina gives the AI only the tool names and the first sentence of each description.
   More generally, Trina drops every MCP server's `instructions` (the `initialize` answer, mcp.ts `start`), which
   Claude Code puts in its system prompt ("MCP Server Instructions").
2. **Nothing tells the AI to choose the account before it acts.** Tools such as Aside's take an optional profile id
   whose own words say "omit to reuse the default"; no rule says that a request about a named account, company,
   mailbox or address must first list the accounts or profiles and pass the matching one, nor that "found nothing in
   one account" is not "it is not there" while others exist.
3. **The agent tool's sign-in failure is a dead end.** Aside's agent (`exec`) needs the Aside account of its profile
   signed in; when it is not, Aside answers "Sign in again before using built-in Aside models". The AI is not told that
   nothing ran, that the code tool (`repl`) works in the same profile without that sign-in, or which accounts are
   signed in.

## Scope

In:
1. Every MCP connection (remote and on the computer): keep the server's `instructions` (cut to a budget, secrets
   hidden), saved with the connection (migration `452_c_integration_instructions.sql`, additive), refreshed by a check
   and whenever a session starts for a call; given to the AI under "Connected services" as that service's own guide
   for its tools, within a total budget, only for connections it can use in this answer.
2. Listed apps on the computer whose guide is a command of their own (preset field `guide`, Aside: `aside guide`): the
   desktop app fills the `instructions` of the `initialize` answer from it when the program gives none, with one line
   that maps its command-line words to its tools.
3. One general rule in "Connected services": when the request names or implies one of the person's accounts
   (organization, mailbox, email address, workspace, person) and a connection works in one of several accounts or
   profiles, list them first, pick the matching one (names in another script or language count: a Korean company name
   and its Latin spelling), pass it in the tool's own account/profile argument (never as words in a free-text task),
   and try the other plausible ones before saying something is not there; ask with the short list only when none
   matches; remember the match (memory rule exists).
4. Aside (the listed connector only, desktop): `repl`/`exec` `profile_id` descriptions say to choose it for the
   request's account and what omitting it does; `browser_profiles` entries say whether their Aside account is signed
   in (exec needs it, repl does not); an exec sign-in failure gets an added note: nothing ran, use repl with the same
   profile_id, or the person signs in to that Aside account.

Out: listing profiles before every turn (a desktop round trip per answer; the rule makes the AI list them when the
request needs it); changing Aside itself; a phrase or service list of any kind.

## Steps

1. Plan (this file), independent plan review.
2. mcp.ts: `instructions` from `initialize` (string, one budget, hidden); `ListedTools.instructions`.
3. Migration 452 + store Row field; service.ts: save on check and after a call's session start when it changed.
4. tools.ts: the guide block per usable connection (budget per connection and in all), and the account rule.
5. shared presets: `guide` args for Aside; desktop local-apps.ts: fill `instructions`, tool description words, profile
   signed-in field, exec sign-in note.
6. Unit tests (mcp instructions, service save, tools prompt, desktop Aside), held-out eval before/after.
7. Decision file, changes note, docs/CONNECTIONS.md if it describes what the AI gets.

## Decisions

`docs/decisions/20261125-connector-guide-and-account-choice.md`: services' own instructions reach the AI like Claude
Code's MCP server instructions; the account rule. Builds on `20261118-local-app-connectors.md` and the deferred tools
decision in `docs/DECISIONS.md`.

## Risks

- Migration number: 452 is the highest + 1 on dev today; renumber at batch time if another PR takes it.
- A remote service's instructions are its own words in the AI's prompt (Claude Code does the same). They are framed as
  the service's guide for its own tools, never above the person's request, the rules or the cards; budgets keep them
  short; secrets are hidden as in descriptions.
- Prompt size: per connection 6,000 characters, 16,000 in all; prompt only (not the per-message context).
- Older desktop apps: no guide filled; the account rule still applies.

## Tests

`bun run typecheck`, `bun run check:prepush`, unit tests for connections (mcp, service, tools) and desktop local apps,
`bun run check:docs`. Eval: a mock profile app with fake profiles on held-out scenarios (other services and accounts),
before and after, with this Mac's Claude login; raw per-run values in the PR.

## Result

(to fill)
