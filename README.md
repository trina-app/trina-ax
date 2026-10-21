# Team AX (code id `mycel`)

A self-hosted team AI workspace for small, non-technical teams (up to about 20 people) that runs on one office Mac:
a Claude-like chat app on top of a shared team folder, where **every member's AI sees only the folders that member
may see**. People use it from the web, the Mac desktop app (with an in-app browser the AI can drive) or a phone
(PWA); the AI engines are Claude Code and the Codex CLI on the team's own subscriptions. Licensed AGPL-3.0
(`ee/` is reserved for enterprise features). Languages: English (default), Korean, Indonesian. Each person picks
their language in Settings > Language (or follows the team default), an admin sets the team default in Admin > Team
settings, and the sign-in, invite, reset and setup screens have a language switcher; see docs/DECISIONS.md "언어".

**Try it now:** [docs/TRY-IT.md](docs/TRY-IT.md) (demo team, accounts, checklist). **Install:**
[docs/INSTALL.md](docs/INSTALL.md); one Mac serving the desks of a small office (no sudo, no relay):
[docs/OFFICE.md](docs/OFFICE.md). **What only the owner can
unblock:** [docs/OWNER-TODO.md](docs/OWNER-TODO.md). Decisions and deviations from the design:
[docs/DECISIONS.md](docs/DECISIONS.md); who owns which part: [docs/WORKPLAN.md](docs/WORKPLAN.md).

## Architecture

```
  browser / PWA          Mac desktop app (Electron)                    phone (PWA)
  ───────────────        ─────────────────────────────────────         ───────────
        │                team web page  +  in-app browser pane ◄── CDP (AI browser tools)
        │                        │
        │  https://<team>.treesoop.com (relay)          or   office network: direct TLS (pinned cert)
        ▼                        ▼
  ┌─────────────────────────────────────┐
  │ relay (Node 25, Linux)              │  frames v2: OPEN/DATA/WINDOW/…, per-stream 256 KB windows,
  │ stores nothing, logs no client IPs  │  Ed25519 team keys; the team server dials OUT (no open ports)
  └──────────────────┬──────────────────┘
                     │ 2–4 control WebSockets
  ┌──────────────────▼──────────────────────────────────────────────────────────────────────────┐
  │ team server  (Bun + Hono + bun:sqlite, account _axserver)                                   │
  │  REST + WebSocket on one zod contract (shared/src/api)   auth · admin · chats · files ·     │
  │  artifacts · jobs · system      realtime hub (seq/epoch/resync)      turn queue             │
  │  ┌───────────────────────┐   ┌──────────────────────────────┐   ┌─────────────────────────┐ │
  │  │ permission function   │◄──│ team tools (MCP over a Unix  │   │ model proxy (company-key│ │
  │  │ server/src/policy     │   │ socket): list glob grep read │   │ / subscription token;   │ │
  │  │ folder rules, groups, │   │ write edit make_file artifact│   │ per-turn tokens)        │ │
  │  │ personal folders      │   │ ask_user remember web_fetch  │   └────────────▲────────────┘ │
  │  └──────────┬────────────┘   │ browser_* (desktop only)     │                │              │
  │             │                └──────────────▲───────────────┘                │              │
  │   team folder (shared/ groups/ projects/ skills/ users/<id>/)  SQLite  backups│              │
  └─────────────┼───────────────────────────────┼────────────────────────────────┼──────────────┘
                │                     mycel-gate (Go): kernel peer PID check,     │
                │                     per-turn token bound to that engine         │
                │                               │                                │
  ┌─────────────┴───────────────────────────────┴────────────────────────────────┴──────────────┐
  │ mycel-launcher (Go) → engine: Claude Code / Codex CLI, locked profile                        │
  │ role-account mode: account _axagent, sandbox-exec profile, pf anchor, per-chat folder        │
  │ DEV mode (`bun run dev`): runs as you with your own logins, locked profile + gate only       │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

```
shared/   zod contracts: REST + WebSocket API (src/api), relay protocol, tool inputs/outputs, engine events, launcher protocol
server/   Bun + Hono + bun:sqlite: route modules (auth, admin, chats, ws, files, artifacts, jobs, system, web), permission
          function, file tools (ripgrep), MCP over a Unix socket, engine runners (Claude Code, Codex CLI), relay client
web/      React + Vite web app, built to web/dist and served by the server (also the PWA)
desktop/  Electron app: the team's web page plus the in-app browser pane the AI can drive
relay/    relay server (Node 25): https://<team>.<domain> for every team server, without opening ports
native/   Go: mycel-gate, mycel-bridge, mycel-launcher, mycel-bootstrap
scripts/  dev runner, dev LaunchAgent, demo seeder, test runner, macOS installer, release bundle;  menubar/  Swift menubar app
tests/    unit + integration (tests/unit), relay conformance (tests/relay), fuzzers, ReDoS, grep benchmark, Linux
          Docker job, engine lockdown regressions, real-engine e2e, install test, whole-product UI e2e
```

## Security model: defense in depth

A short Korean summary with a diagram: [docs/PERMISSIONS.md](docs/PERMISSIONS.md). Design tabs 2 and 7 are the source; `docs/DECISIONS.md` records where the code differs and why. Three layers, each
meant to hold on its own:

1. **One permission function** (`server/src/policy`) decides every read and write, for people (REST, file screen)
   and for the AI (tools) alike: folder rules per group / role / person, a personal folder `users/<id>/` per person
   that nobody else sees (not even the owner), owner/admin rules, strict name rules (Unicode normalization, case,
   Windows-reserved and look-alike names), and "not found or no access" with the same wording so hidden folders do
   not show. Access is re-checked live on every tool call; when someone loses access, their chats start fresh
   engine sessions. Writing into a folder more people can read than the sources the chat has read asks first.
2. **Engine lockdown: the AI reaches team files only through our tools.** Claude Code and the Codex CLI run with a
   locked profile: no shell, no built-in file tools, no CLAUDE.md / skills / hooks / plugins / git context, only the
   team MCP tools plus Claude's WebSearch. The tools are served over a Unix socket behind `mycel-gate` (Go), which
   reads the caller's process from the kernel; a per-turn token is accepted only from that turn's engine session.
   `tests/engine/lockdown-*.ts` re-checks the profile against the real CLIs, and a failed check marks that engine
   version as unusable.
3. **OS backstop (role-account mode):** the engine runs as the hidden account `_axagent` under `sandbox-exec`
   (`scripts/macos/engine.sb`) with a pf anchor (only the local model proxy is reachable), in per-chat folders the
   launcher creates; the server account never runs anything from those folders, and root never trusts files the
   role accounts can change. The profile also hides metadata: a turn can stat() only its own paths and the folders
   above them, except the agent folder that holds every chat folder (its size and time would count and time other
   people's chats), and of `/` only the system folders. Because any process of the account can read another one's argv and environment (macOS does not let
   a sandbox stop that), no engine's argv or environment names its chat: the launcher passes chat paths relative to
   the engine's working folder and the sandbox parameters in a randomly named profile copy. In DEV mode (`bun run dev`) this layer is only partly there: on macOS every turn still runs under
   `engine.sb` (its chat folder plus the few login files Claude Code / Codex need, not the rest of your home, the
   data folder or the team folder; engines do not start without it), but it runs as you, with direct HTTPS and no
   pf, which every screen says in a banner. In this mode Claude Code also puts your Claude
   account's email into every turn's context (no switch for it).

Around them:

- **Web:** cookie sessions (`__Host-`), a CSRF header on every write, an Origin check on WebSockets, a strict CSP
  without inline scripts; artifacts and HTML previews run in sandboxed frames that load `/sandbox/frame` and get
  their document by postMessage. Owner-only actions that cannot be undone (update, restore, connection change,
  ownership) ask for the password again. Sign-in is rate-limited per account and per real client IP.
- **Outbound:** no tool sends anything out (no mail, no posting); `web_fetch` refuses private and office addresses
  on every redirect hop; the model proxy forwards only the Messages API shapes Claude Code needs.
- **Relay:** stores nothing it forwards and logs no client IPs (team ids, byte counts and times only).
- **Desktop browser pane:** never opens the team's own addresses or this computer; office-network sites and every
  new site need the person's answer in the pane's own toolbar; password fields are refused.

## Dev quickstart

```sh
bun install
bun run dev                 # server http://localhost:19100 + relay http://demo.localhost:19161, data in ~/.team-ax-dev
bun run demo:seed           # (other terminal) demo team: dion / admin1 / alice / bob, password teamax-demo-1
```

`bun run dev` builds what is missing (native helpers, needs Go; the web app when `web/` changed) and starts:

- the team server on **http://localhost:19100**, serving the web app, in DEV mode: Claude Code and the Codex CLI run
  as you, with your own logins (`local-login`, no model proxy);
- the relay on Node 25, with the team registered as `demo`: **http://demo.localhost:19161** (the remote address);
- with `--vite`, also the hot-reloading web dev server on http://localhost:19140.

Data lives in `~/.team-ax-dev` (team folder, database, relay registry); delete it to start over. On the first start
the server log prints a setup link (`/setup?token=…`) that creates the team and its owner — or run
`bun run demo:seed`, which creates the demo team through the same API (see [docs/TRY-IT.md](docs/TRY-IT.md)).
`bun run dev admin status | reset-link [--username U]` runs the account CLI on that data (a one-time password reset
link for a forgotten owner password); plain `bun run admin` works on `<repo>/.dev`, the folder of `bun run dev:server`.

Keep it running in the background (macOS LaunchAgent `app.team-ax.dev`, restarts on crash and at login):

```sh
bun run dev:service install | status | logs | restart | stop | start | uninstall
```

Desktop app: `cd desktop && bun run app` (development) or `bun run dist:mac` (unsigned .dmg in `desktop/release/`).

Needs Bun, Go, Node 25 (relay), `rg`, `pandoc`, `pdftotext`, `ffmpeg`, `whisper-cli` (Homebrew), Docker for the Linux
job, and for real chats a logged-in `claude` and/or `codex`.

## Tests

```sh
bun run typecheck             # server, shared, relay, tests, scripts + web + desktop
bun run test                  # unit + integration, web unit, relay conformance (Node 25); test:fast skips the relay
bun run build                 # native helpers (darwin + linux) and web/dist
bun run test:stage1:fast      # typecheck, native build, unit, path fuzzers, ReDoS, 20k-file grep benchmark
bun run test:stage1           # + real engines (local claude / codex logins) and the Linux Docker job
bun run e2e:web               # Playwright against the built web app (mock server)
bun run test:desktop:e2e      # Electron app with a fake team server
bun run test:b:e2e            # chat turns with the real engines (calls Claude / Codex)
bun run e2e:ui                # whole product in a real browser + the Electron app against bun run dev
                              # (real engines: about 9 Claude and 1 Codex calls; needs ports 19100/19161 free,
                              # so stop the dev service first: bun run dev:service stop)
sudo bun tests/install/g-macos-install.ts   # role-account installer on a throwaway copy with a fake engine
```

Engines are never called for real by `bun run test`. CI (`.github/workflows/ci.yml`) runs typecheck, the native build
+ `go vet`, unit tests, the fast fuzzers, web unit tests and build, the relay suite on Node 25 and the Linux Docker
job. As of 2026-10-21 the GitHub Actions jobs of this repository do not start at all ("recent account payments have
failed or your spending limit needs to be increased"), so every red run on `main` is that, not a test failure; run
`bun run typecheck && bun run test` locally until the billing is fixed.

## Office mode: one Mac for a small office

[docs/OFFICE.md](docs/OFFICE.md) (Korean runbook, with an English summary; printable PDF:
[docs/office/Team-AX-사무실모드-설치가이드.pdf](docs/office/Team-AX-사무실모드-설치가이드.pdf), desk guide
[docs/office/Team-AX-윈도우-데스크-가이드.pdf](docs/office/Team-AX-윈도우-데스크-가이드.pdf); one team's copies with its address are
built from the same source with `docs/install/build-pdf.ts --team-host …`, see OFFICE.md appendix A). `bun run build:office` makes one zip
(`dist/office/TeamAX-office-<version>-mac.zip`: bun, ripgrep, pandoc and the native helpers for arm64 and x64, the
built server and web app); `bash office-install.sh` installs it into `~/TeamAX` without sudo, as the signed-in user
with that Mac's own Claude Code login (dev mode's engine setup: permission function, lockdown, `engine.sb`; no DEV
banner), as the LaunchAgent `app.team-ax.office`. Desks use `https://<LAN IP>:8443` with a certificate from a
office CA made on that Mac and constrained to its own names and office subnet (CA download page on
`http://<LAN IP>:8442`; desks compare the thumbprint with the desk card printed on the Mac, `teamax card`). Plain HTTP
stays on 127.0.0.1, the office port answers only peers on the Mac's office subnet, and Codex is off. Code: `server/src/office/`, `scripts/office/`, `scripts/build-office.ts`.

## Install on a Mac (role-account mode)

**Step-by-step install guide: [docs/INSTALL.md](docs/INSTALL.md)** (dev mode, production install, connecting
members, update/backup/uninstall, troubleshooting, known gaps; Korean illustrated PDF:
[docs/install/Team-AX-설치가이드.pdf](docs/install/Team-AX-설치가이드.pdf)). In this version a production install
answers Claude chats once the owner stored a `claude setup-token` token (subscription mode, INSTALL.md 2.4); the
role-account run of that path still waits for a `sudo` test run (`tests/install/g-macos-install.ts`).

```sh
bun run build:bundle                                    # native helpers, web/dist, then scripts/build-bundle.ts
sudo scripts/install-macos.sh --from dist/release --allow-unsigned --engine claude=<path to claude>
sudo scripts/uninstall-macos.sh [--delete-data]
sudo "/Library/Application Support/mycel/root/mycel-account" reset-link   # owner password recovery (no email)
```

`--engine` takes `claude=` and/or `codex=`; `scripts/install-macos.sh --check …` checks everything without root.
Re-running the installer with a newer bundle switches to it and keeps the old version for roll-back;
`bun run build:bundle:universal` builds one bundle for Apple silicon and Intel.

The installer (what the signed setup package will run) creates the hidden role accounts `_axserver` (server) and
`_axagent` (engine), the LaunchDaemons, the sandbox profile and pf rules, `config/server.json` and a one-time setup
code; flags and the full list are in its header. The engine running as `_axagent` needs its own subscription login
(`claude setup-token`, stored with `pbpaste | sudo "<install>/root/set-claude-token"`; for Codex the owner runs
`admin.js codex-login` once, which signs `_axagent` in by device auth through the launcher and the model proxy,
docs/INSTALL.md 2.5), which only the owner can do — see [docs/OWNER-TODO.md](docs/OWNER-TODO.md). Codex on the
engine account is beta (owner only) until it is verified with a real login and pf on.

## Status (2026-10-21)

Done and running on the owner's MacBook in DEV mode (`bun run dev:service`, demo team seeded):

- **Stage 1 — permission groundwork:** permission function, file tools on ripgrep (with Office/PDF text), Unix-socket
  MCP + turn tokens, Go gate / bridge / launcher, locked Claude Code and Codex runners with session stash/restore and
  refusal retry, model proxy, fuzzers and lockdown regressions.
- **Stage 2 — the product:** sign-in, invites (copy a link), password reset links, members, groups, folder rules
  with a "who sees what" preview, engines, usage limits, audit (A); chats with streaming, branches, stop / regenerate
  / edit, ask_user cards, memories, projects, the realtime hub (B); file screen with previews (PDF, Word,
  PowerPoint, Excel, CSV, images), versions, trash, chunked uploads, artifacts, make_file, web_fetch, transcription
  (C); the web app and PWA in ko/en/id (D); the desktop app with the in-app browser pane (E); relay protocol v2 on
  Node 25 (F); installer, diagnostics, backups, restore, export, updates, menubar app (G); four review passes
  (security, correctness, product/UX, contract drift).

Blocked on the owner (details and exact steps in [docs/OWNER-TODO.md](docs/OWNER-TODO.md)): the engine running as
`_axagent` (`claude setup-token`, Codex device login), Apple signing and notarization, the production relay
(Linux + Cloudflare `*.treesoop.com`), a separate team-address domain, the product name and public GitHub release,
Windows signing, mail (not needed for v1: invites are copy-a-link by design), GitHub Actions billing. Production
Claude chats run in subscription mode (`engine.authMode: "subscription"`): the engine account talks only to the model
proxy, which adds the owner's setup-token. Company-key mode stays code-only by owner decision: with
`engine.authMode: "proxy"` Claude Code reports `proxy_mode` as not available.
