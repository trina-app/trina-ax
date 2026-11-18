# Apps on your own computer as connectors (Aside, ego lite)

- Date (UTC): 2026-11-18 17:31
- Branch: `feat/local-app-connectors` (phase 1), then `feat/local-app-connectors-desktop` (phase 2) and
  `feat/local-app-connectors-cli` (phase 3), each stacked on the one before
- Status: done (three PRs, waiting for review)
- Where: Team AX core (server, shared, web, desktop). Why: connections, the relay and the desktop app are core.
- Version impact: minor (a new kind of connection, a new team setting, a new desktop bridge part)

## Goal

People connect local browser and desktop tools (Aside, ego lite, later Playwright MCP, Chrome DevTools MCP,
agent-browser) to the AI through the Trina desktop app. The AI stays on the server; the program runs on the person's
computer. Decision: [20261118-local-app-connectors](../../decisions/20261118-local-app-connectors.md).

## Scope

In:

1. **Phase 1 (server):** `server/src/realtime/call-relay.ts` (the common part of the browser relay); the browser relay
   on it, unchanged in behaviour; `server/src/realtime/local-relay.ts` with `local.call` / `local.ack` /
   `local.result` / `local.cancel` and a long-poll fallback (`server/src/routes/local-apps.ts`); the shared contract
   `shared/src/api/local-apps.ts`; kind `local` (migration: column `integrations.local_app`); create and change it only
   as the person's own connection (`POST /api/integrations/local`, `PATCH /api/integrations/:id/local`); refused by
   team connections, templates, requests, `connect_service`, the skills share; `mayUse` owner-only; the tools offered
   only in a turn from a desktop window, never to a sub-agent; the team switch `localApps`; the plain-words line for
   the AI from other windows.
2. **Phase 2 (desktop):** the bridge part `localApps`; the web relay for `local.call`; the desktop process manager
   (argument list, no shell, never root, Stop, stop on quit); the confirm in the desktop app's own dialog, asked again
   only when the command changes; setting values in safeStorage, hidden in results; adapter (a) stdio MCP passthrough;
   tried with real Aside on a public page.
3. **Phase 3 (CLI and screens):** adapter (b) declared CLI tools (ego lite with a fake CLI in tests); Settings ›
   Connectors › Add › An app on your computer (known tools: Aside, ego lite; or a command typed by the person), the
   connection page (works only from the desktop app, running or not, Stop, settings), the admin switch, the audit's
   words.

Out: Windows and Linux confirm and known commands (later); a server-side browser for self-hosted servers.

## Steps

1. Plan and decision (this commit).
2. Phase 1 as above, with tests; PR to dev.
3. Phase 2 as above, with tests and a real Aside run; PR to dev.
4. Phase 3 as above, with tests; PR to dev.

## Decisions

[docs/decisions/20261118-local-app-connectors.md](../../decisions/20261118-local-app-connectors.md), updated for the
owner's 2026-11-19 call (no PC runner, the browser relay, two adapters, lean rules, desktop window only, macOS first).

## Risks

- Migration: one additive column (reader 1); the number checked against `origin/dev` and open PRs.
- Security: a program runs on the person's computer with their rights. Kept to the seven rules of the decision: the
  person adds the command, no shell, personal only, a one-time confirm in the app's own window, setting values on the
  computer, never root plus Stop, an admin switch.
- About 17 files branch on `IntegrationKind`: each handles or refuses `local`.
- Five app languages (en first) and the desktop app's own words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `MIGRATIONS_BASE=origin/dev bun run check:migrations`;
server tests under Bun 1.3.12: the relay (call, ack, result, resend, cancel, long-poll, window gone), the kind
refusals (team, template, request, connect card, other people, sub-agents, switch off), no-shell argument building,
a fake stdio MCP end to end from the server's `McpClient` through the relay to the desktop process manager, the fake
CLI adapter; the desktop e2e when it runs here.

## Result

- **Phase 1, #1330:** the relay's common part (`call-relay.ts`), the local relay with long-poll, kind `local` (migration 364), every refusal, the team switch, and the AI's plain-words line.
- **Phase 2, #1331:** the desktop manager, the app's own confirm dialog, stdio MCP passthrough, safeStorage settings, Stop and stop on quit. It was tried with real Aside: `repl` opened example.com through the full server path.
- **Phase 3, this branch:** adapter (b) for a declared CLI (ego lite as a known tool, tested with a fake CLI). The web screens: Discover › An app on your computer (desktop app only), the connection's page (where it works, what runs, Running and Stop, settings on this computer), the admin switch, the audit's words, and `docs/INTEGRATIONS.md`.

What differs from the plan: a person-typed program is always an MCP server (adapter a). A declared CLI comes from the known tools list only, because typing argument templates is not a job for the people this app is for. Changing a command has an API (`PATCH /api/integrations/:id/local`), but no screen yet: delete and add again.
