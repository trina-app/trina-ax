# Try Trina AX locally

Allow about **10 minutes on a prepared Mac** to install dependencies, build and explore the synthetic demo.
A fresh Mac needs additional tool installation time (the [full guide](INSTALL.md#11-tools) estimates 30–60 minutes).
Network speed and build caches affect the time. This is a development preview, not a production installation.

## Prerequisites

- Git, Bun **1.3.12** (the CI pin), Go **1.27+**, and a free port **19720**.
- macOS developer tools for native builds. Building both architectures below also covers Intel Macs.
- Optional for AI chat: supported Claude Code or Codex CLI, installed and signed in on this Mac. See [engine versions](INSTALL.md#11-tools).
- PDF/Office extraction, PDF output and voice input need additional tools from the full installation guide. They are not needed to browse the seeded Markdown glossary.

## 1. Build and start

```sh
git clone https://github.com/trina-app/trina-ax.git
cd trina-ax
bun install --frozen-lockfile
ARCHS="arm64 amd64" bun run build
TEAM_AX_DEV_DIR="$HOME/.trina-ax-demo" TEAM_AX_DEV_PORT=19720 bun run dev --no-relay
```

Leave this terminal running. The server serves the built web app. `--no-relay` avoids needing a relay or Node for
this walkthrough. Do not use `--vite` here; it starts a separate development port.

Use a fresh `.trina-ax-demo` directory and synthetic data. Engines run as your OS account with your local CLI logins;
**development mode has no production OS isolation**. Do not expose the demo to the internet or use company documents.

## 2. Seed a team

In another terminal, change into the same `trina-ax` checkout and run:

```sh
TEAM_AX_DEV_DIR="$HOME/.trina-ax-demo" bun run demo:seed --base http://127.0.0.1:19720
```

Do this before creating your own team in the setup screen. The seed uses the local setup token without requiring
you to copy it. It refuses an existing team with a different owner and only fills missing seed data on repeat runs.

Open **http://127.0.0.1:19720**. Sign in as `alice` with `teamax-demo-1`. These are intentionally public demo
credentials, never credentials for a real deployment. The seed's owner and other users are listed in
[`scripts/demo/seed.ts`](../scripts/demo/seed.ts).

The demo is Korean. Use **Settings → Profile → Language** to switch to English, or keep it in Korean.

## 3. Reach a first result without a model

1. Open **Files → shared → 팀-용어집.md**. You should see a glossary table, including the term `전환율`.
2. Browse the marketing group folder. It is available to `alice`.
3. In a private browser window, open the same address and sign in as `bob` with the same demo password.
4. Bob can browse the finance group; the marketing group's files and the finance payroll subfolder are hidden from him. This exercises application permissions, not production OS isolation.

You have now tested the browser, server, seeded files and per-person folder access without a model call.

## 4. Optional: ask the AI

With a supported CLI installed and logged in on the Mac, start a new chat as `alice` and ask:

> Read shared/팀-용어집.md and explain 전환율 in one sentence. Cite the file.

An answer uses your local CLI account and its provider's usage allowance. Expand the tool steps to inspect which
file was read. If the engine is unavailable, check its installation/login and the native build; file browsing
still works. [More examples](EXAMPLES.md).

## Stop and troubleshoot

Press **Ctrl-C in the first terminal**. The development supervisor stops its child processes. The files remain in
`$HOME/.trina-ax-demo`; after stopping, you may remove that dedicated demo directory if you want a fresh start.
Do not remove a directory used by a real team.

- **Port in use:** stop your own demo process, or choose another free port and use it consistently in both commands and the browser.
- **Existing team:** choose a new data directory in both terminals; do not reset a real team's data to seed a demo.
- **Sign-in repeats:** keep using `127.0.0.1`; `localhost` has a separate cookie origin.
- **Socket path too long:** use a short directory under your home folder, as shown above.
- **Missing converter:** install the relevant tool from [INSTALL.md](INSTALL.md); a text-only demo does not require every converter.

For a real team, follow [Linux installation](INSTALL-LINUX.md) or [office Mac installation](OFFICE.md), with fresh
accounts and the production isolation setup.
