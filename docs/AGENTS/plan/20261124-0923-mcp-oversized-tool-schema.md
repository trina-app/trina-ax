# Remote MCP connectors: a tool whose input schema is too large is shortened, not silently dropped

- Date (UTC): 2026-11-24 09:23
- Branch: `fix/mcp-oversized-tool-schema`
- Status: in progress
- Where: server (`server/src/integrations/connections/mcp.ts`, `service.ts`, `store.ts`, `oauth.ts`), one migration
  (component C), web (`ConnectionPage.tsx`, i18n). Why: the server reads and keeps an MCP server's tool list; Settings
  shows it.
- Version impact: patch (bug fix; one additive column read only by this build, no new interface)

## Goal

A remote MCP server can list a tool whose input schema is long because of its words: one property's `description` is
a whole command reference (seen in 2026-11 at a service whose default mode offers one tool whose schema is 31-37 KB).
`toolOf` (mcp.ts) left out every tool whose schema JSON is over `MAX_SCHEMA_CHARS` (32,000), with no log. The check
then saved an empty list as Connected, and Settings said "The service listed no tools. Try checking again." Checking
again changes nothing, and nobody can tell why.

A second silent loss in the same sign-in path: `discover` (oauth.ts) joins every scope the protected-resource metadata
advertises; over 2,000 characters it sent no `scope` at all, with no log.

Nothing here is keyed to one service: any server whose tool schemas or scope list is long gets the same behaviour.

## Scope

In:

1. `toolOf`: a schema over the cap is shortened. The longest `description` strings in it (at any depth of the schema;
   never inside `default`, `const`, `enum` or `examples`, which are values, not words) are cut to one common length,
   the largest that makes the JSON fit, each ending in "… (shortened)". Only when the schema still does not fit with
   every description cut (its structure alone is too large) is the tool left out. The tool's own description keeps its
   1,000-character cut and now ends with the same marker when cut.
2. `listTools` returns which tools were shortened and which were left out (name and original size); `check`
   (service.ts) writes one server log line per listing that had any (connection id, its name, the tool names and
   sizes, at most 20 of each; never a key or token).
3. The number left out is saved with the list (`integrations.tools_dropped`, new migration
   `365_c_integration_tools_dropped.sql`, additive, reader 1) and shown in the API as `toolsTooLarge` when above 0.
   Settings, for a connected connection whose list is empty only because of that, says the service's tools were too
   large to load instead of "listed no tools". No new button.
4. Scopes: when the joined advertised scopes are over 2,000 characters, the sign-in still asks for no `scope` (the
   authorization server's default grant, as when a server advertises none), and `discover` says so
   (`scopeOmitted: { count, chars }`); the sign-in writes one log line. An own app's scope (and the server's
   `WWW-Authenticate` scope hint) is used as before.

Out: a per-service address change (such as a "tools" mode query on one service's URL), a list of the tools left out in
Settings, and raising the cap for one tool.

## Decisions

- Per-tool cap stays 32,000 characters. A turn offers connection tools directly only up to `MAX_TURN_TOOL_CHARS`
  (50,000, tools.ts) in all, so one tool larger than 32,000 would take most of a turn's budget and push every other
  connection to find_tools; 32,000 characters is about 8,000 tokens for one tool. The 4,000,000-character total
  (`MAX_SCHEMAS_CHARS`) still applies to the shortened size. With shortening, the cap now costs the tail of a long
  description, not the tool.
- Shortening cuts descriptions only: names, types, `required`, `enum` and other structure the AI needs to call the
  tool correctly are never changed. One common length (water level) keeps the short descriptions whole and cuts the
  long ones evenly, instead of cutting the first ones met.
- Scope over the limit: sending no scope is what the code already did and what a server without advertised scopes
  gets; every existing provider keeps working. Sending a cut subset would ask for an arbitrary part of the scopes and
  could leave out the one a tool needs; raising the limit risks an authorization address some servers refuse as too
  long. The difference now is that it is logged and visible to tests.
- New decision file: none (a fix inside the decision "Connection tools: deferred, found and called").

## Risks

- Migration number: highest of component C on dev is 364; 365 is free on dev and in open PRs (checked 2026-11-24).
- A shortened description may cut words the AI needed; the marker tells it the text was cut.
- Logs: tool names and sizes only; names that carry a secret are already refused before this (hide check).

## Tests

- `tests/unit/mcp-oversized-tool-schema.test.ts`: a schema just over the cap is kept shortened and fits; a nested long
  description is cut, short ones stay whole, values in `enum`/`default` stay; a schema that cannot fit is dropped and
  reported; the total cap still counts the shortened size; a check whose only tool was dropped saves `toolsTooLarge`
  and the log line; the scope list over the limit is omitted and reported.
- `tests/unit/safe-ops-policy-epoch.test.ts`: the new column is bookkeeping.
- `bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, the remote-mcp unit tests.

## Result

(filled in at the end)
