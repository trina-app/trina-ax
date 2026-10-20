# Team AX (code id `mycel`)

A team AI workspace that runs on one Mac mini: a chat app on top of a shared team folder, where every member's AI sees only the folders that member may see. Licensed AGPL-3.0 (`ee/` is reserved for enterprise features).

Stage 1 ("permission groundwork") built the permission function, the file tools the AI uses, the native tool gate and engine launcher, locked engine runners for Claude Code and the Codex CLI, and the test suites. Stage 2 built the product on a shared REST / WebSocket contract (`shared/src/api`): sign-in and administration (A), chats and the realtime hub (B), the files screen, uploads, artifacts and jobs (C), the web app (D), the desktop app (E), the relay (F) and the installer and operations (G). Who owns what is in [docs/WORKPLAN.md](docs/WORKPLAN.md); decisions and deviations from the design are in [docs/DECISIONS.md](docs/DECISIONS.md).

```
shared/   zod contracts: REST + WebSocket API (src/api), relay protocol, tool inputs/outputs, engine events, launcher protocol
server/   Bun + Hono + bun:sqlite: route modules (auth, admin, chats, ws, files, artifacts, jobs, system, web), permission
          function, file tools (ripgrep), MCP over a Unix socket, engine runners (Claude Code, Codex CLI), relay client
web/      React + Vite web app, built to web/dist and served by the server (also the PWA)
desktop/  Electron app: the team's web page plus the in-app browser pane the AI can drive
relay/    relay server (Node 25): https://<team>.<domain> for every team server, without opening ports
native/   Go: mycel-gate, mycel-bridge, mycel-launcher, mycel-bootstrap
scripts/  dev runner, test runner, macOS installer, release bundle;  menubar/  Swift menubar app
tests/    unit + integration (tests/unit), relay conformance (tests/relay), fuzzers, ReDoS, grep benchmark, Linux
          Docker job, engine lockdown regressions, real-engine e2e, install test
```

## Run it (dev)

```sh
bun install
bun run dev
```

`bun run dev` builds what is missing (native helpers, needs Go; the web app when `web/` changed) and starts:

- the team server on **http://localhost:19100**, serving the web app, in DEV mode: Claude Code and the Codex CLI run
  as you, with your own logins (`local-login`, no model proxy);
- the relay on Node 25, with the team registered as `demo`: **http://demo.localhost:19161** (the remote address);
- with `--vite`, also the hot-reloading web dev server on http://localhost:19140.

Data lives in `~/.team-ax-dev` (team folder, database, relay registry); delete it to start over. On the first start
the server log prints a setup link (`/setup?token=…`) that creates the team and its owner.

## Build and test

```sh
bun run typecheck             # server, shared, relay, tests + web + desktop
bun run test                  # unit + integration, web unit, relay conformance (Node 25); test:fast skips the relay
bun run build                 # native helpers (darwin + linux) and web/dist
bun run test:stage1:fast      # typecheck, native build, unit, path fuzzers, ReDoS, 20k-file grep benchmark
bun run test:stage1           # + real engines (local claude / codex logins) and the Linux Docker job
bun run e2e:web               # Playwright against the built web app
bun run test:desktop:e2e      # Electron app with a fake team server
bun run test:b:e2e            # chat turns with the real engines (calls Claude / Codex)
bun run e2e:ui                # whole product in a real browser + the Electron app against bun run dev
                              # (real engines: about 9 Claude and 1 Codex calls; see tests/e2e-ui/playwright.config.ts)
```

Needs Bun, Go, Node 25 (relay), `rg`, `pandoc`, `pdftotext`, `ffmpeg` (Homebrew), Docker for the Linux job.
