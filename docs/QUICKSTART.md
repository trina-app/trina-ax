# Try Trina AX locally

[한국어](QUICKSTART.ko.md) · [Team guide](for-teams.md)

Allow about **10 minutes on a prepared Mac** to install dependencies, build and explore the synthetic demo.
A fresh Mac needs additional tool installation time (the [full guide](INSTALL.md#11-tools) estimates 30–60 minutes).
Network speed and build caches affect the time. This is a development preview, not a production installation.

## Prerequisites

- Git, Bun **1.3.12** (the CI pin), Go **1.27+**, and a free port **19760**.
- Native build tools (Xcode command-line tools on macOS). macOS and Linux source builds are supported; this walkthrough was exercised on macOS, and Linux evaluation needs validation on your machine. Windows users connect to a prepared server in a browser.
- Optional for AI chat: supported Claude Code or Codex CLI, installed and signed in on this Mac. See [engine versions](INSTALL.md#11-tools).
- PDF/Office extraction, PDF output and voice input need additional tools from the full installation guide. They are not needed to browse the seeded Markdown glossary.

## 1. Build and start

```sh
git clone https://github.com/trina-app/trina-ax.git
cd trina-ax
bun install --frozen-lockfile
bun run demo
```

Leave this terminal running. The launcher builds, starts on loopback **http://127.0.0.1:19760**, and automatically seeds a new fictional team, six starter skills and a labeled illustrative result. It disables AI even if the machine has CLI logins, and starts no relay. No AI account is required. This demonstrates application permissions, not production OS isolation; use no real company data.

## 2. Open the seeded team

Sign in as `alice` with `teamax-demo-1` (intentionally public fictional credentials). The other accounts are `bob`, `admin1` and owner `dion`. Do not create your own team or run a second seed command.

The files are Korean; the UI starts in English. To choose a different port, fresh data path and Korean UI:

```sh
bun run demo --port 19761 --data "$HOME/.trina-evaluation-new" --locale ko
```

The data path must not exist. Busy ports and existing directories are refused. Each default run creates a new dedicated directory and prints its path and supervisor PID. Profile → Language supports English, Korean, Indonesian, Japanese and Spanish.

## 3. Reach a first result without a model

1. Open **Files → shared → 팀-용어집.md**. You should see a glossary table, including the term `전환율`.
2. Browse the marketing group folder. It is available to `alice`.
3. In a private browser window, open the same address and sign in as `bob` with the same demo password.
4. Bob can browse the finance group; the marketing group's files and the finance payroll subfolder are hidden from him. This exercises application permissions, not production OS isolation.

You have now tested the browser, server, seeded files and per-person folder access without a model call.

## 4. Optional: ask the AI

The model-free launcher cannot call AI. For a separate optional development environment, stop it first, use a permitted CLI account, and run:

```sh
TEAM_AX_DEV_DIR="$HOME/.trina-ai-evaluation-new" TEAM_AX_DEV_PORT=19761 bun run dev --no-relay
# In a second terminal, before creating a team:
TEAM_AX_DEV_DIR="$HOME/.trina-ai-evaluation-new" bun run demo:seed --base http://127.0.0.1:19761
```

Use a fresh data directory and fictional files. Engines run as your OS user; development mode lacks production OS isolation. Open http://127.0.0.1:19761 as `alice`. Choose the matching engine
in the chat composer (Claude Code by default; select Codex if that is the CLI you connected), then ask:

> Read shared/팀-용어집.md and explain 전환율 in one sentence. Cite the file.

An answer uses your local CLI account and its provider's usage allowance. Expand the tool steps to inspect which
file was read. If the engine is unavailable, check its installation/login and the native build; file browsing
still works. [More examples](EXAMPLES.md).

## Stop and troubleshoot

Press **Ctrl-C in the first terminal**. The development supervisor stops its child processes. The files remain in
the dedicated directory printed by the launcher (or `$HOME/.trina-ai-evaluation-new` for the optional AI run); after stopping, you may remove that dedicated demo directory if you want a fresh start.
Do not remove a directory used by a real team.

- **Build failure:** inspect the first failed build command; verify Git, Bun, Go and native build tools. A failed demo can leave an empty directory; choose a new path on retry.
- **Port in use:** stop your own demo process, or choose another free port and use it consistently in both commands and the browser.
- **Existing team:** choose a new data directory in both terminals; do not reset a real team's data to seed a demo.
- **Sign-in repeats:** keep using `127.0.0.1`; `localhost` has a separate cookie origin.
- **Socket path too long:** use a short directory under your home folder, as shown above.
- **Missing converter:** install the relevant tool from [INSTALL.md](INSTALL.md); a text-only demo does not require every converter.

For a real team, follow [Linux installation](INSTALL-LINUX.md) or [office Mac installation](OFFICE.md), with fresh
accounts and the production isolation setup.
