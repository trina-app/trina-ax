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
`bun run dev admin status | reset-link [--username U]` runs the account CLI on that data (a one-time password reset
link for a forgotten owner password); plain `bun run admin` works on `<repo>/.dev`, the folder of `bun run dev:server`.

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

CI (`.github/workflows/ci.yml`) runs typecheck, the native build + `go vet`, unit tests, the fast fuzzers, web unit tests
and build, the relay suite on Node 25 and the Linux Docker job. Real-engine tests never run in CI (they need the
owner's logins). As of 2026-10-21 the GitHub Actions jobs of this repository do not start at all ("recent account
payments have failed or your spending limit needs to be increased"), so every red run on `main` is that, not a test
failure; run `bun run typecheck && bun run test` locally until the billing is fixed.

## Install on a Mac (role-account mode)

```sh
bun run build:bundle                                    # native helpers, web/dist, then scripts/build-bundle.ts
sudo scripts/install-macos.sh --from dist/release --allow-unsigned --engine claude=<path to claude>
sudo scripts/uninstall-macos.sh [--delete-data]
sudo bun tests/install/g-macos-install.ts               # install test: a throwaway copy with a fake engine
```

The installer (what the signed setup package will run) creates the hidden role accounts `_axserver` (server) and
`_axagent` (engine), the LaunchDaemons, the sandbox profile and pf rules, `config/server.json` and a one-time setup
code; flags and the full list are in its header. The engine running as `_axagent` needs its own subscription login
(`claude setup-token`, `codex login --device-auth`), which only the owner can do — until then use `bun run dev`
(see "Not done yet").

## Security model (short)

Design tabs 2 and 7 are the source; `docs/DECISIONS.md` records where the code differs and why.

- **One permission function** (`server/src/policy`) decides every read and write, for people (REST, file screen) and
  for the AI (tools) alike: folder rules per group, a personal folder `users/<id>/` per person, owner/admin rules,
  strict name rules, and "not found or no access" with the same wording so hidden folders do not show.
- **The AI reaches team files only through our tools.** The engine (Claude Code / Codex CLI) runs with a locked
  profile: no shell, no built-in file tools, no CLAUDE.md / skills / hooks / plugins / git context, only the team MCP
  tools plus Claude's WebSearch. The tools are served over a Unix socket behind `mycel-gate` (Go), which reads the
  caller's process from the kernel; a per-turn token is accepted only from that turn's engine session.
  `tests/engine/lockdown-*.ts` re-checks the profile against the real CLIs.
- **Role-account mode adds OS isolation:** the engine runs as `_axagent` under `sandbox-exec` (`scripts/macos/engine.sb`)
  with a pf anchor, in per-chat folders the launcher creates; the server account never runs anything from those
  folders. In DEV mode (`bun run dev`) the engine runs as you and only the locked profile and the tool gate apply;
  in this mode Claude Code also puts your Claude account's email into every turn's context (no switch for it).
- **Web:** cookie sessions (`__Host-`), a CSRF header on every write, an Origin check on WebSockets, a strict CSP
  without inline scripts; artifacts and HTML previews run in sandboxed frames that load `/sandbox/frame` and get
  their document by postMessage. Owner-only actions that cannot be undone (update, restore, connection change,
  ownership) ask for the password again.
- **Relay:** stores nothing it forwards and logs no client IPs (team ids, byte counts and times only).
- **Desktop browser pane:** never opens the team's own addresses or this computer; office-network sites and every
  new site need the person's answer in the pane's own toolbar; password fields are refused.

## Not done yet (needs the owner)

- Running the engine as `_axagent`: the owner's `claude setup-token` and `codex login --device-auth`. Until then the
  product runs in DEV mode as the current user (local-login); the role-account installer is tested with a fake engine.
- Apple signing and notarization (desktop app, menubar app, helpers), the production relay (Linux + Cloudflare,
  `*.treesoop.com`), mail (invites are copy-a-link by design for now), a company API key for the model-proxy mode
  (code and tests only: with `engine.authMode: "proxy"` Claude Code reports `proxy_mode` as not available).
- GitHub Actions billing (see Build and test).
